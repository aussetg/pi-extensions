import fs from "node:fs";
import path from "node:path";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import {
  projectCommandProfileDir,
  userCommandProfileDir,
} from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";

export type CommandProfileNamespace = "builtin" | "user" | "project";
export type CommandEffect = "read-only" | "temporary" | "candidate";
export type CommandArgumentValue = string | number | boolean;
export type CommandArgumentValues = Record<string, CommandArgumentValue>;

interface CommandArgumentCommon {
  description?: string;
  default?: CommandArgumentValue;
}

export interface StringCommandArgument extends CommandArgumentCommon {
  type: "string";
  default?: string;
  minimumBytes?: number;
  maximumBytes?: number;
  enum?: string[];
}

export interface ProjectPathCommandArgument extends CommandArgumentCommon {
  type: "project-path";
  default?: string;
  maximumBytes?: number;
}

export interface IntegerCommandArgument extends CommandArgumentCommon {
  type: "integer";
  default?: number;
  minimum?: number;
  maximum?: number;
}

export interface BooleanCommandArgument extends CommandArgumentCommon {
  type: "boolean";
  default?: boolean;
}

export type CommandArgumentDefinition =
  | StringCommandArgument
  | ProjectPathCommandArgument
  | IntegerCommandArgument
  | BooleanCommandArgument;

export interface CommandProfileDefinition {
  name: string;
  title?: string;
  description: string;
  /** Fixed argv template. Only a complete `${name}` token may be substituted. */
  argv: string[];
  arguments?: Record<string, CommandArgumentDefinition>;
  env?: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  effects: CommandEffect[];
}

export interface CommandProfileRef extends CommandProfileDefinition {
  id: `${CommandProfileNamespace}:${string}`;
  namespace: CommandProfileNamespace;
  path: string;
  hash: string;
}

export type CommandProfileSnapshot = CommandProfileRef;

export interface InvalidCommandProfileRef {
  namespace: CommandProfileNamespace;
  path: string;
  name: string;
  error: string;
}

export interface CommandProfileRegistryRefreshOptions {
  /** Enable only after project trust is established. */
  includeProject?: boolean;
  userDir?: string;
  projectDir?: string;
  builtins?: readonly CommandProfileDefinition[];
}

export interface ResolvedCommandInvocation {
  profileId: string;
  profileHash: string;
  effect: CommandEffect;
  arguments: CommandArgumentValues;
  argumentsHash: string;
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  hash: string;
}

const PROFILE_FIELDS = new Set([
  "name", "title", "description", "argv", "arguments", "env", "timeoutMs", "outputLimitBytes", "effects",
]);
const ARGUMENT_FIELDS = new Set([
  "type", "description", "default", "minimumBytes", "maximumBytes", "enum", "minimum", "maximum",
]);
const ARGUMENT_FIELDS_BY_TYPE: Record<CommandArgumentDefinition["type"], ReadonlySet<string>> = {
  string: new Set(["type", "description", "default", "minimumBytes", "maximumBytes", "enum"]),
  "project-path": new Set(["type", "description", "default", "maximumBytes"]),
  integer: new Set(["type", "description", "default", "minimum", "maximum"]),
  boolean: new Set(["type", "description", "default"]),
};
const PLACEHOLDER = /^\$\{([a-z][a-z0-9_-]{0,63})\}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = /^(?:HOME|PATH|LANG|LC_ALL|PWD|OLDPWD|SHLVL|_|LD_.+|BASH_ENV|ENV)$/;

export const BUILTIN_COMMAND_PROFILES: readonly CommandProfileDefinition[] = Object.freeze([
  deepFreezeJson({
    name: "tracked-files",
    title: "Project files",
    description: "Lists regular files below one bounded project-relative path without invoking a shell.",
    argv: ["/usr/bin/find", "${path}", "-type", "f", "-print"],
    arguments: {
      path: { type: "project-path" },
    },
    timeoutMs: 30_000,
    outputLimitBytes: 8 * 1024 * 1024,
    effects: ["read-only"],
  } as unknown as JsonValue) as unknown as CommandProfileDefinition,
]);

export class CommandProfileRegistry {
  private refs = new Map<string, CommandProfileRef>();
  private invalid: InvalidCommandProfileRef[] = [];

  async refresh(cwd: string, options: CommandProfileRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, CommandProfileRef>();
    const invalid: InvalidCommandProfileRef[] = [];
    const builtins = options.builtins ?? BUILTIN_COMMAND_PROFILES;
    addNamespace("builtin", builtins.map((definition) => {
      try {
        return { ref: profileRef("builtin", `<builtin:${String(definition.name)}>`, definition) };
      } catch (error) {
        return { error: invalidRef("builtin", `<builtin:${String(definition.name)}>`, String(definition.name), error) };
      }
    }), refs, invalid);

    const roots: Array<{ namespace: "user" | "project"; directory: string }> = [
      { namespace: "user", directory: options.userDir ?? userCommandProfileDir() },
    ];
    if (options.includeProject === true) {
      roots.push({ namespace: "project", directory: options.projectDir ?? projectCommandProfileDir(cwd) });
    }
    for (const root of roots) {
      const entries: Array<{ ref?: CommandProfileRef; error?: InvalidCommandProfileRef }> = [];
      let files: string[];
      try {
        files = await listJsonFiles(root.directory);
      } catch (error) {
        invalid.push(invalidRef(root.namespace, root.directory, "<registry>", error));
        continue;
      }
      for (const filePath of files) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("Command profile must be a regular non-symlink file");
          }
          const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.commandProfileBytes);
          entries.push({ ref: profileRef(root.namespace, filePath, parseCommandProfile(source, filePath)) });
        } catch (error) {
          entries.push({ error: invalidRef(root.namespace, filePath, path.basename(filePath, ".json"), error) });
        }
      }
      addNamespace(root.namespace, entries, refs, invalid);
    }
    this.refs = refs;
    this.invalid = invalid;
  }

  list(): CommandProfileRef[] {
    return [...this.refs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listInvalid(): InvalidCommandProfileRef[] {
    return [...this.invalid].sort((left, right) => left.path.localeCompare(right.path));
  }

  get(id: string): CommandProfileRef | undefined {
    return this.refs.get(id);
  }

  resolve(selector: string): CommandProfileRef {
    return resolveCommandProfile(this.list(), selector);
  }

  invocation(selector: string, args: unknown, effect: CommandEffect): ResolvedCommandInvocation {
    return resolveCommandInvocation(this.resolve(selector), args, effect);
  }
}

export function parseCommandProfile(source: string, filePath = "<profile>"): CommandProfileDefinition {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Command profile is not JSON: ${message(error)}`);
  }
  return normalizeCommandProfile(value, filePath);
}

export function normalizeCommandProfile(value: unknown, filePath = "<profile>"): CommandProfileDefinition {
  const profile = strictRecord(value, PROFILE_FIELDS, "command profile");
  const name = boundedText(profile.name, "command profile name", 64);
  if (!FLOW_NAME_PATTERN.test(name)) throw new Error("Command profile name must match ^[a-z][a-z0-9_-]{0,63}$");
  if (filePath !== "<profile>" && !filePath.startsWith("<builtin:") && path.basename(filePath, ".json") !== name) {
    throw new Error(`Command profile name ${name} must match filename ${path.basename(filePath, ".json")}`);
  }
  const title = profile.title === undefined ? undefined : boundedText(profile.title, "command profile title", 192);
  const description = boundedText(profile.description, "command profile description", DEFINITION_LIMITS.profileDescriptionScalars);
  const definitions = normalizeArguments(profile.arguments);
  const argv = normalizeArgv(profile.argv, definitions);
  const env = normalizeEnvironment(profile.env);
  const timeoutMs = integer(profile.timeoutMs, "command timeoutMs", 1, DEFINITION_LIMITS.commandTimeoutMs);
  const outputLimitBytes = integer(
    profile.outputLimitBytes,
    "command outputLimitBytes",
    1,
    DEFINITION_LIMITS.commandStreamBytes,
  );
  const effects = normalizeEffects(profile.effects);
  return deepFreezeJson(canonicalJsonObject({
    name,
    ...(title ? { title } : {}),
    description,
    argv,
    ...(Object.keys(definitions).length ? { arguments: definitions } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
    timeoutMs,
    outputLimitBytes,
    effects,
  }, profileLimits())) as unknown as CommandProfileDefinition;
}

export function resolveCommandProfile(
  profiles: readonly CommandProfileSnapshot[],
  selector: string,
): CommandProfileSnapshot {
  if (typeof selector !== "string") throw new Error("Command profile selector must be a string");
  if (selector.includes(":")) {
    if (!/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(selector)) {
      throw new Error(`Invalid command profile selector ${selector}`);
    }
    const exact = profiles.find((profile) => profile.id === selector);
    if (!exact) throw new Error(`Unknown command profile ${selector}`);
    return cloneSnapshot(exact);
  }
  if (!FLOW_NAME_PATTERN.test(selector)) throw new Error(`Invalid command profile selector ${selector}`);
  const matches = profiles.filter((profile) => profile.name === selector);
  if (matches.length === 0) throw new Error(`Unknown command profile ${selector}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous command profile ${selector}; use one of ${matches.map((profile) => profile.id).join(", ")}`);
  }
  return cloneSnapshot(matches[0]!);
}

export function assertCommandEffectAllowed(profile: CommandProfileSnapshot, effect: CommandEffect): void {
  if (!["read-only", "temporary", "candidate"].includes(effect)) throw new Error(`Invalid command effect ${String(effect)}`);
  if (!profile.effects.includes(effect)) {
    throw new Error(`Command profile ${profile.id} does not permit the ${effect} effect`);
  }
}

/**
 * Substitute complete argv tokens only. Values never pass through a shell and
 * can neither split one argument nor replace the fixed executable.
 */
export function resolveCommandInvocation(
  profile: CommandProfileSnapshot,
  argsValue: unknown,
  effect: CommandEffect,
): ResolvedCommandInvocation {
  assertCommandProfileSnapshot(profile);
  assertCommandEffectAllowed(profile, effect);
  const supplied = canonicalJsonObject(argsValue ?? {}, argumentLimits());
  const definitions = profile.arguments ?? {};
  const suppliedKeys = Object.keys(supplied).sort();
  const definitionKeys = Object.keys(definitions).sort();
  const unknown = suppliedKeys.find((key) => !Object.prototype.hasOwnProperty.call(definitions, key));
  if (unknown) throw new Error(`Command profile ${profile.id} received unknown argument ${unknown}`);
  const args: CommandArgumentValues = {};
  for (const name of definitionKeys) {
    const definition = definitions[name]!;
    const suppliedValue = supplied[name];
    const value = suppliedValue === undefined ? definition.default : suppliedValue;
    if (value === undefined) throw new Error(`Command profile ${profile.id} requires argument ${name}`);
    args[name] = normalizeArgumentValue(name, definition, value);
  }
  const argv = profile.argv.map((token, index) => {
    const placeholder = PLACEHOLDER.exec(token);
    if (!placeholder) return token;
    if (index === 0) throw new Error("Command executable cannot be supplied by an argument");
    const value = args[placeholder[1]!];
    if (value === undefined) throw new Error(`Command argv references unresolved argument ${placeholder[1]}`);
    return String(value);
  });
  const argumentsHash = stableHash(args);
  const body = {
    profileId: profile.id,
    profileHash: profile.hash,
    effect,
    arguments: args,
    argumentsHash,
    argv,
    env: structuredClone(profile.env ?? {}),
    timeoutMs: profile.timeoutMs,
    outputLimitBytes: profile.outputLimitBytes,
  };
  return deepFreezeJson({ ...body, hash: stableHash(body) } as unknown as JsonValue) as unknown as ResolvedCommandInvocation;
}

export function assertCommandProfileSnapshot(profile: CommandProfileSnapshot): void {
  if (
    !profile || typeof profile !== "object" ||
    !["builtin", "user", "project"].includes(profile.namespace) ||
    typeof profile.path !== "string" || profile.path.length === 0 ||
    !/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(profile.id)
  ) {
    throw new Error("Command profile snapshot identity is invalid");
  }
  const { id, namespace, path: profilePath, hash, ...definition } = profile;
  const normalized = normalizeCommandProfile(definition, profilePath);
  if (id !== `${namespace}:${normalized.name}` || hash !== stableHash({ namespace, definition: normalized })) {
    throw new Error(`Command profile ${id} content hash is invalid`);
  }
}

function normalizeArguments(value: unknown): Record<string, CommandArgumentDefinition> {
  if (value === undefined) return {};
  const record = strictRecord(value, undefined, "command arguments");
  const names = Object.keys(record).sort();
  if (names.length > DEFINITION_LIMITS.commandProfileArguments) {
    throw new Error(`Command profile has more than ${DEFINITION_LIMITS.commandProfileArguments} arguments`);
  }
  const result: Record<string, CommandArgumentDefinition> = {};
  for (const name of names) {
    if (!FLOW_NAME_PATTERN.test(name)) throw new Error(`Invalid command argument name ${name}`);
    const raw = strictRecord(record[name], ARGUMENT_FIELDS, `command argument ${name}`);
    if (!["string", "project-path", "integer", "boolean"].includes(String(raw.type))) {
      throw new Error(`Command argument ${name} has an invalid type`);
    }
    const type = raw.type as CommandArgumentDefinition["type"];
    assertAllowedKeys(raw, ARGUMENT_FIELDS_BY_TYPE[type], `command argument ${name}`);
    const description = raw.description === undefined
      ? undefined
      : boundedText(raw.description, `command argument ${name} description`, 512);
    let definition: CommandArgumentDefinition;
    if (type === "string") {
      const minimumBytes = raw.minimumBytes === undefined ? 0 : integer(raw.minimumBytes, `${name} minimumBytes`, 0, DEFINITION_LIMITS.commandArgBytes);
      const maximumBytes = raw.maximumBytes === undefined
        ? Math.min(4_096, DEFINITION_LIMITS.commandArgBytes)
        : integer(raw.maximumBytes, `${name} maximumBytes`, 1, DEFINITION_LIMITS.commandArgBytes);
      if (minimumBytes > maximumBytes) throw new Error(`Command argument ${name} has inverted byte bounds`);
      const choices = raw.enum === undefined ? undefined : stringChoices(raw.enum, name, minimumBytes, maximumBytes);
      definition = { type, ...(description ? { description } : {}), minimumBytes, maximumBytes, ...(choices ? { enum: choices } : {}) };
    } else if (type === "project-path") {
      const maximumBytes = raw.maximumBytes === undefined
        ? Math.min(4_096, DEFINITION_LIMITS.commandArgBytes)
        : integer(raw.maximumBytes, `${name} maximumBytes`, 1, DEFINITION_LIMITS.commandArgBytes);
      definition = { type, ...(description ? { description } : {}), maximumBytes };
    } else if (type === "integer") {
      const minimum = raw.minimum === undefined ? -1_000_000_000 : integer(raw.minimum, `${name} minimum`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const maximum = raw.maximum === undefined ? 1_000_000_000 : integer(raw.maximum, `${name} maximum`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (minimum > maximum) throw new Error(`Command argument ${name} has inverted numeric bounds`);
      definition = { type, ...(description ? { description } : {}), minimum, maximum };
    } else {
      definition = { type, ...(description ? { description } : {}) };
    }
    if (raw.default !== undefined) {
      definition = { ...definition, default: normalizeArgumentValue(name, definition, raw.default) } as CommandArgumentDefinition;
    }
    result[name] = definition;
  }
  return result;
}

function normalizeArgv(value: unknown, definitions: Record<string, CommandArgumentDefinition>): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DEFINITION_LIMITS.commandArgv) {
    throw new Error(`Command argv must contain 1–${DEFINITION_LIMITS.commandArgv} tokens`);
  }
  const referenced = new Set<string>();
  const argv = value.map((token, index) => {
    if (typeof token !== "string" || token.includes("\0") || Buffer.byteLength(token) > DEFINITION_LIMITS.commandArgBytes) {
      throw new Error(`Command argv[${index}] is invalid`);
    }
    const placeholder = PLACEHOLDER.exec(token);
    if (placeholder) {
      if (index === 0) throw new Error("Command executable must be fixed by the reviewed profile");
      if (!Object.prototype.hasOwnProperty.call(definitions, placeholder[1]!)) {
        throw new Error(`Command argv references undeclared argument ${placeholder[1]}`);
      }
      referenced.add(placeholder[1]!);
    } else if (token.includes("${")) {
      throw new Error(`Command argv[${index}] may substitute only a complete \${name} token`);
    }
    return token;
  });
  if (!path.posix.isAbsolute(argv[0]!)) throw new Error("Command profile executable must be an absolute path");
  const unused = Object.keys(definitions).find((name) => !referenced.has(name));
  if (unused) throw new Error(`Command argument ${unused} is declared but never used`);
  return argv;
}

function normalizeArgumentValue(
  name: string,
  definition: CommandArgumentDefinition,
  value: unknown,
): CommandArgumentValue {
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Command argument ${name} must be boolean`);
    return value;
  }
  if (definition.type === "integer") {
    if (!Number.isSafeInteger(value) || (value as number) < (definition.minimum ?? Number.MIN_SAFE_INTEGER) || (value as number) > (definition.maximum ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Command argument ${name} is outside its integer bounds`);
    }
    return value as number;
  }
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`Command argument ${name} must be a safe string`);
  const bytes = Buffer.byteLength(value);
  if (definition.type === "project-path") {
    if (bytes < 1 || bytes > (definition.maximumBytes ?? 4_096)) throw new Error(`Command argument ${name} exceeds its path bound`);
    const normalized = path.posix.normalize(value);
    if (
      value.includes("\\") || path.posix.isAbsolute(value) || normalized !== value ||
      value === ".." || value.startsWith("../") || value.includes("/../") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)
    ) throw new Error(`Command argument ${name} must be a normalized project-relative path`);
    return value;
  }
  if (bytes < (definition.minimumBytes ?? 0) || bytes > (definition.maximumBytes ?? 4_096)) {
    throw new Error(`Command argument ${name} is outside its string byte bounds`);
  }
  if (definition.enum && !definition.enum.includes(value)) throw new Error(`Command argument ${name} is not an allowed value`);
  return value;
}

function normalizeEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = strictRecord(value, undefined, "command environment");
  const keys = Object.keys(record).sort();
  if (keys.length > DEFINITION_LIMITS.commandEnv) throw new Error("Command environment has too many entries");
  const result: Record<string, string> = {};
  for (const key of keys) {
    const entry = record[key];
    if (!ENV_NAME.test(key) || RESERVED_ENV.test(key)) throw new Error(`Command environment key ${key} is reserved or invalid`);
    if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > DEFINITION_LIMITS.commandEnvValueBytes) {
      throw new Error(`Command environment value ${key} is invalid`);
    }
    result[key] = entry;
  }
  return result;
}

function normalizeEffects(value: unknown): CommandEffect[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("Command profile effects must be a non-empty array");
  }
  const result = new Set<CommandEffect>();
  for (const effect of value) {
    if (effect !== "read-only" && effect !== "temporary" && effect !== "candidate") {
      throw new Error(`Invalid command profile effect ${String(effect)}`);
    }
    if (result.has(effect)) throw new Error(`Duplicate command profile effect ${effect}`);
    result.add(effect);
  }
  return [...result].sort();
}

function profileRef(
  namespace: CommandProfileNamespace,
  filePath: string,
  definition: CommandProfileDefinition,
): CommandProfileRef {
  const normalized = normalizeCommandProfile(definition, filePath);
  return deepFreezeJson(canonicalJsonObject({
    ...normalized,
    id: `${namespace}:${normalized.name}`,
    namespace,
    path: filePath,
    hash: stableHash({ namespace, definition: normalized }),
  }, profileLimits())) as unknown as CommandProfileRef;
}

function cloneSnapshot(profile: CommandProfileSnapshot): CommandProfileSnapshot {
  assertCommandProfileSnapshot(profile);
  return deepFreezeJson(structuredClone(profile) as unknown as JsonValue) as unknown as CommandProfileSnapshot;
}

function addNamespace(
  namespace: CommandProfileNamespace,
  entries: Array<{ ref?: CommandProfileRef; error?: InvalidCommandProfileRef }>,
  refs: Map<string, CommandProfileRef>,
  invalid: InvalidCommandProfileRef[],
): void {
  invalid.push(...entries.flatMap((entry) => entry.error ? [entry.error] : []));
  const groups = new Map<string, CommandProfileRef[]>();
  for (const ref of entries.flatMap((entry) => entry.ref ? [entry.ref] : [])) {
    groups.set(ref.name, [...(groups.get(ref.name) ?? []), ref]);
  }
  for (const [name, group] of groups) {
    if (group.length > 1) {
      for (const ref of group) invalid.push(invalidRef(namespace, ref.path, name, new Error(`Duplicate ${namespace} command profile ${name}`)));
    } else {
      refs.set(group[0]!.id, group[0]!);
    }
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe command profile directory ${directory}`);
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > DEFINITION_LIMITS.commandProfileFilesPerNamespace) {
    throw new Error(`Command profile directory exceeds ${DEFINITION_LIMITS.commandProfileFilesPerNamespace} entries`);
  }
  return entries.filter((entry) => entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name)).sort();
}

function strictRecord(value: unknown, allowed: ReadonlySet<string> | undefined, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (allowed && !allowed.has(key))) throw new Error(`${label} contains unknown field ${String(key)}`);
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.trim() === "" || Array.from(value).length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
  ) throw new Error(`${label} must contain 1–${maximum} safe Unicode scalars`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function stringChoices(value: unknown, name: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error(`Command argument ${name} enum is invalid`);
  const choices = value.map((entry) => {
    if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) < minimum || Buffer.byteLength(entry) > maximum) {
      throw new Error(`Command argument ${name} enum entry is outside its bounds`);
    }
    return entry;
  });
  if (new Set(choices).size !== choices.length) throw new Error(`Command argument ${name} enum contains duplicates`);
  return choices;
}

function invalidRef(namespace: CommandProfileNamespace, filePath: string, name: string, error: unknown): InvalidCommandProfileRef {
  return { namespace, path: filePath, name, error: message(error) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.commandProfileBytes,
    maxDepth: 16,
    maxNodes: 4_096,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}

function argumentLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.commandArgumentsBytes,
    maxDepth: 4,
    maxNodes: DEFINITION_LIMITS.commandProfileArguments * 2 + 1,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}
