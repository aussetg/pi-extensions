import fs from "node:fs";
import path from "node:path";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { getAgentDir, projectRoot, PROJECT_CONFIG_DIR_NAME } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { normalizeCandidateWriteScope, type CandidateWriteScope } from "../candidates/store.js";

export type VerificationProfileNamespace = "builtin" | "user" | "project";

export interface VerificationCommandProfile {
  id: string;
  argv: string[];
  timeoutMs: number;
  env?: Record<string, string>;
}

export type VerificationCommandGate = VerificationCommandProfile[] | { notApplicable: string };

export interface VerificationDiffPolicy {
  requireChanges: boolean;
  maximumChangedPaths: number;
  maximumFileBytes: number;
  forbidSecrets: boolean;
  paths: "all-semantic-project-paths" | CandidateWriteScope;
}

export type VerificationReviewPolicy =
  | { profile: string; instructions?: string }
  | { notApplicable: string };

export interface VerificationProfileDefinition {
  name: string;
  title?: string;
  description: string;
  tests: VerificationCommandGate;
  diagnostics: VerificationCommandGate;
  diffInspection: VerificationDiffPolicy;
  adversarialReview: VerificationReviewPolicy;
  scratchPaths?: string[];
}

export interface VerificationProfileRef extends VerificationProfileDefinition {
  id: `${VerificationProfileNamespace}:${string}`;
  namespace: VerificationProfileNamespace;
  path: string;
  hash: string;
}

export type VerificationProfileSnapshot = VerificationProfileRef;

export interface InvalidVerificationProfileRef {
  namespace: VerificationProfileNamespace;
  path: string;
  name: string;
  error: string;
}

export interface VerificationProfileRegistryRefreshOptions {
  includeProject?: boolean;
  userDir?: string;
  projectDir?: string;
  builtins?: readonly VerificationProfileDefinition[];
}

const PROFILE_FIELDS = new Set([
  "name", "title", "description", "tests", "diagnostics", "diffInspection", "adversarialReview", "scratchPaths",
]);
const COMMAND_FIELDS = new Set(["id", "argv", "timeoutMs", "env"]);
const DIFF_FIELDS = new Set(["requireChanges", "maximumChangedPaths", "maximumFileBytes", "forbidSecrets", "paths"]);
const REVIEW_FIELDS = new Set(["profile", "instructions", "notApplicable"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class VerificationProfileRegistry {
  private refs = new Map<string, VerificationProfileRef>();
  private invalid: InvalidVerificationProfileRef[] = [];

  async refresh(cwd: string, options: VerificationProfileRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, VerificationProfileRef>();
    const invalid: InvalidVerificationProfileRef[] = [];
    const builtinDefinitions = options.builtins ?? await discoverBuiltinProfiles(cwd);
    addNamespace("builtin", builtinDefinitions.map((definition) => {
      try { return { ref: profileRef("builtin", `<builtin:${String(definition.name)}>`, definition) }; }
      catch (error) { return { error: invalidRef("builtin", `<builtin:${String(definition.name)}>`, String(definition.name), error) }; }
    }), refs, invalid);

    const roots: Array<{ namespace: "user" | "project"; dir: string }> = [
      { namespace: "user", dir: options.userDir ?? path.join(getAgentDir(), "verifications") },
    ];
    if (options.includeProject === true) {
      roots.push({
        namespace: "project",
        dir: options.projectDir ?? path.join(projectRoot(cwd), PROJECT_CONFIG_DIR_NAME, "verifications"),
      });
    }
    for (const root of roots) {
      const entries: Array<{ ref?: VerificationProfileRef; error?: InvalidVerificationProfileRef }> = [];
      let files: string[];
      try { files = await listJsonFiles(root.dir); }
      catch (error) { invalid.push(invalidRef(root.namespace, root.dir, "<registry>", error)); continue; }
      for (const filePath of files) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Verification profile must be a regular non-symlink file");
          const text = await readBoundedTextFile(filePath, DEFINITION_LIMITS.verificationProfileBytes);
          entries.push({ ref: profileRef(root.namespace, filePath, parseVerificationProfile(text, filePath)) });
        } catch (error) {
          entries.push({ error: invalidRef(root.namespace, filePath, path.basename(filePath, ".json"), error) });
        }
      }
      addNamespace(root.namespace, entries, refs, invalid);
    }
    this.refs = refs;
    this.invalid = invalid;
  }

  list(): VerificationProfileRef[] { return [...this.refs.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  listInvalid(): InvalidVerificationProfileRef[] { return [...this.invalid].sort((a, b) => a.path.localeCompare(b.path)); }
  get(id: string): VerificationProfileRef | undefined { return this.refs.get(id); }
  resolve(selector: string): VerificationProfileRef { return resolveVerificationProfile(this.list(), selector); }
}

export function resolveVerificationProfile(
  profiles: readonly VerificationProfileSnapshot[],
  selector: string,
): VerificationProfileSnapshot {
  if (typeof selector !== "string") throw new Error("Verification profile selector must be a string");
  if (selector.includes(":")) {
    if (!/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(selector)) throw new Error(`Invalid verification profile selector ${selector}`);
    const exact = profiles.find((profile) => profile.id === selector);
    if (!exact) throw new Error(`Unknown verification profile ${selector}`);
    return deepFreezeJson(structuredClone(exact) as unknown as JsonValue) as unknown as VerificationProfileSnapshot;
  }
  if (!FLOW_NAME_PATTERN.test(selector)) throw new Error(`Invalid verification profile selector ${selector}`);
  const matches = profiles.filter((profile) => profile.name === selector);
  if (matches.length === 0) throw new Error(`Unknown verification profile ${selector}`);
  if (matches.length > 1) throw new Error(`Ambiguous verification profile ${selector}; use one of ${matches.map((profile) => profile.id).join(", ")}`);
  return deepFreezeJson(structuredClone(matches[0]!) as unknown as JsonValue) as unknown as VerificationProfileSnapshot;
}

export function parseVerificationProfile(text: string, filePath = "<profile>"): VerificationProfileDefinition {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Verification profile is not JSON: ${message(error)}`); }
  return normalizeVerificationProfile(value, filePath);
}

export function normalizeVerificationProfile(value: unknown, filePath = "<profile>"): VerificationProfileDefinition {
  const profile = strictRecord(value, PROFILE_FIELDS, "verification profile");
  const name = boundedString(profile.name, "verification profile name", 64);
  if (!FLOW_NAME_PATTERN.test(name)) throw new Error("Verification profile name must match ^[a-z][a-z0-9_-]{0,63}$");
  if (filePath !== "<profile>" && !filePath.startsWith("<builtin:") && path.basename(filePath, ".json") !== name) {
    throw new Error(`Verification profile name ${name} must match filename ${path.basename(filePath, ".json")}`);
  }
  const title = profile.title === undefined ? undefined : boundedString(profile.title, "verification profile title", 192);
  const description = boundedString(profile.description, "verification profile description", 2_000);
  const tests = normalizeCommandGate(profile.tests, "tests");
  const diagnostics = normalizeCommandGate(profile.diagnostics, "diagnostics");
  const diffInspection = normalizeDiffPolicy(profile.diffInspection);
  const adversarialReview = normalizeReview(profile.adversarialReview);
  const scratchPaths = profile.scratchPaths === undefined ? undefined : normalizeScratchPaths(profile.scratchPaths);
  return deepFreezeJson(canonicalJsonObject({
    name, ...(title ? { title } : {}), description, tests, diagnostics, diffInspection, adversarialReview,
    ...(scratchPaths?.length ? { scratchPaths } : {}),
  }, profileLimits())) as unknown as VerificationProfileDefinition;
}

function normalizeCommandGate(value: unknown, label: string): VerificationCommandGate {
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > DEFINITION_LIMITS.verificationCommands) {
      throw new Error(`Verification ${label} requires 1–${DEFINITION_LIMITS.verificationCommands} commands or notApplicable`);
    }
    const ids = new Set<string>();
    return value.map((entry, index) => {
      const command = strictRecord(entry, COMMAND_FIELDS, `verification ${label}[${index}]`);
      const id = boundedString(command.id, `verification ${label}[${index}] id`, 64);
      if (!FLOW_NAME_PATTERN.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate verification command id ${id}`);
      ids.add(id);
      const argv = normalizeArgv(command.argv, `verification ${label}[${index}]`);
      const timeoutMs = integer(command.timeoutMs, `verification ${label}[${index}] timeoutMs`, 1, DEFINITION_LIMITS.commandTimeoutMs);
      const env = normalizeEnvironment(command.env, `verification ${label}[${index}]`);
      return { id, argv, timeoutMs, ...(env ? { env } : {}) };
    });
  }
  const record = strictRecord(value, new Set(["notApplicable"]), `verification ${label}`);
  return { notApplicable: boundedString(record.notApplicable, `verification ${label} notApplicable`, 2_000) };
}

function normalizeDiffPolicy(value: unknown): VerificationDiffPolicy {
  const record = strictRecord(value, DIFF_FIELDS, "verification diffInspection");
  const requireChanges = boolean(record.requireChanges, "verification diffInspection requireChanges", true);
  const maximumChangedPaths = integer(record.maximumChangedPaths ?? DEFINITION_LIMITS.candidateChangedPaths, "verification maximumChangedPaths", 1, DEFINITION_LIMITS.candidateChangedPaths);
  const maximumFileBytes = integer(record.maximumFileBytes ?? DEFINITION_LIMITS.candidateFileBytes, "verification maximumFileBytes", 1, DEFINITION_LIMITS.candidateFileBytes);
  const forbidSecrets = boolean(record.forbidSecrets, "verification diffInspection forbidSecrets", true);
  const paths = record.paths === undefined || record.paths === "all-semantic-project-paths"
    ? "all-semantic-project-paths"
    : normalizeCandidateWriteScope(record.paths as CandidateWriteScope);
  return { requireChanges, maximumChangedPaths, maximumFileBytes, forbidSecrets, paths };
}

function normalizeReview(value: unknown): VerificationReviewPolicy {
  const record = strictRecord(value, REVIEW_FIELDS, "verification adversarialReview");
  if (record.notApplicable !== undefined) {
    if (record.profile !== undefined || record.instructions !== undefined) throw new Error("Adversarial review notApplicable cannot name a profile");
    return { notApplicable: boundedString(record.notApplicable, "adversarial review notApplicable", 2_000) };
  }
  if (Object.keys(record).some((key) => !["profile", "instructions"].includes(key))) throw new Error("Invalid adversarial review policy");
  const profile = boundedString(record.profile, "adversarial review profile", 128);
  if (!/^(?:(?:builtin|user|project):)?[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error("Adversarial review profile is invalid");
  const instructions = record.instructions === undefined ? undefined : boundedString(record.instructions, "adversarial review instructions", 8_000);
  return { profile, ...(instructions ? { instructions } : {}) };
}

function normalizeScratchPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > DEFINITION_LIMITS.candidateScopeRules) throw new Error("Verification scratchPaths is invalid");
  if (value.length === 0) return [];
  const normalized = normalizeCandidateWriteScope({ allow: value });
  if (normalized === "all-semantic-project-paths") throw new Error("Verification scratchPaths failed normalization");
  return normalized.allow;
}

async function discoverBuiltinProfiles(cwd: string): Promise<VerificationProfileDefinition[]> {
  const root = projectRoot(cwd);
  const command = (id: string, argv: string[]): VerificationCommandProfile => ({ id, argv, timeoutMs: 30 * 60_000 });
  let tests: VerificationCommandProfile[] | undefined;
  let diagnostics: VerificationCommandProfile[] | undefined;
  try {
    const packagePath = path.join(root, "package.json");
    const stat = await fs.promises.lstat(packagePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DEFINITION_LIMITS.verificationProfileBytes) throw new Error("package.json is unsafe");
    const pkg = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
    const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    if (typeof scripts.test === "string" && scripts.test.trim()) tests = [command("tests", ["/usr/bin/npm", "test"] )];
    for (const script of ["typecheck", "check", "lint"]) {
      if (typeof scripts[script] === "string" && scripts[script].trim()) { diagnostics = [command(script, ["/usr/bin/npm", "run", script])]; break; }
    }
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (!tests && await exists(path.join(root, "Cargo.toml"))) tests = [command("tests", ["/usr/bin/cargo", "test"] )];
  if (!diagnostics && await exists(path.join(root, "Cargo.toml"))) diagnostics = [command("check", ["/usr/bin/cargo", "check"] )];
  // Missing mandatory discovery means builtin:coding does not exist. A workflow
  // selecting it is blocked during resource preparation instead of receiving a
  // weaker profile.
  if (!tests || !diagnostics) return [];
  return [{
    name: "coding",
    title: "Coding verification",
    description: "Conservatively discovered project tests, diagnostics, deterministic diff inspection, and adversarial review.",
    tests,
    diagnostics,
    diffInspection: {
      requireChanges: true,
      maximumChangedPaths: DEFINITION_LIMITS.candidateChangedPaths,
      maximumFileBytes: DEFINITION_LIMITS.candidateFileBytes,
      forbidSecrets: true,
      paths: "all-semantic-project-paths",
    },
    adversarialReview: { profile: "builtin:reviewer" },
  }];
}

function profileRef(namespace: VerificationProfileNamespace, filePath: string, definition: VerificationProfileDefinition): VerificationProfileRef {
  const normalized = normalizeVerificationProfile(definition, filePath);
  return deepFreezeJson(canonicalJsonObject({
    ...normalized, id: `${namespace}:${normalized.name}`, namespace, path: filePath,
    hash: stableHash({ namespace, definition: normalized }),
  }, profileLimits())) as unknown as VerificationProfileRef;
}

function addNamespace(
  namespace: VerificationProfileNamespace,
  entries: Array<{ ref?: VerificationProfileRef; error?: InvalidVerificationProfileRef }>,
  refs: Map<string, VerificationProfileRef>,
  invalid: InvalidVerificationProfileRef[],
): void {
  invalid.push(...entries.flatMap((entry) => entry.error ? [entry.error] : []));
  const groups = new Map<string, VerificationProfileRef[]>();
  for (const ref of entries.flatMap((entry) => entry.ref ? [entry.ref] : [])) groups.set(ref.name, [...(groups.get(ref.name) ?? []), ref]);
  for (const [name, group] of groups) {
    if (group.length > 1) {
      for (const ref of group) invalid.push(invalidRef(namespace, ref.path, name, new Error(`Duplicate ${namespace} verification profile ${name}`)));
    } else refs.set(group[0]!.id, group[0]!);
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe verification profile directory ${directory}`);
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  if (entries.length > DEFINITION_LIMITS.verificationProfileFilesPerNamespace) throw new Error("Verification profile directory exceeds its entry bound");
  return entries.filter((entry) => entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name)).sort();
}

function strictRecord(value: unknown, allowed: Set<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error(`${label} contains unknown field ${String(key)}`);
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error(`${label}.${key} must be an enumerable data property`);
  }
  return value as Record<string, unknown>;
}

function normalizeArgv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DEFINITION_LIMITS.commandArgv) throw new Error(`${label} argv is invalid`);
  return value.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\0") || (index === 0 && !argument) || Buffer.byteLength(argument) > DEFINITION_LIMITS.commandArgBytes) {
      throw new Error(`${label} argv[${index}] is invalid`);
    }
    return argument;
  });
}

function normalizeEnvironment(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = strictRecord(value, new Set(Object.keys(value as object)), `${label} env`);
  const keys = Object.keys(record).sort();
  if (keys.length > DEFINITION_LIMITS.commandEnv) throw new Error(`${label} env has too many entries`);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const entry = record[key];
    if (!ENV_NAME.test(key) || typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > DEFINITION_LIMITS.commandEnvValueBytes) {
      throw new Error(`${label} env entry ${key} is invalid`);
    }
    result[key] = entry;
  }
  return result;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || Array.from(value).length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must contain 1–${maximum} safe Unicode scalars`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be ${minimum}–${maximum}`);
  return value as number;
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function invalidRef(namespace: VerificationProfileNamespace, filePath: string, name: string, error: unknown): InvalidVerificationProfileRef {
  return { namespace, path: filePath, name, error: message(error) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function exists(filePath: string): Promise<boolean> { try { return (await fs.promises.lstat(filePath)).isFile(); } catch { return false; } }
function profileLimits() {
  return { maxBytes: DEFINITION_LIMITS.verificationProfileBytes, maxDepth: DEFINITION_LIMITS.schemaDepth, maxNodes: DEFINITION_LIMITS.schemaNodes, maxStringScalars: DEFINITION_LIMITS.agentPromptScalars };
}
