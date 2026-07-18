import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { getAgentDir, projectRoot, PROJECT_CONFIG_DIR_NAME } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";

export type MeasurementProfileNamespace = "builtin" | "user" | "project";

export interface JsonPathMeasurementExtractor {
  kind: "json-path";
  path: string;
}

export interface RegexMeasurementExtractor {
  kind: "regex";
  pattern: string;
  group?: number | string;
  flags?: "" | "i" | "m" | "im";
}

export interface ProtocolMeasurementExtractor {
  kind: "protocol";
}

export type NumericMeasurementExtractor =
  | JsonPathMeasurementExtractor
  | RegexMeasurementExtractor
  | ProtocolMeasurementExtractor;

export type DiagnosticMeasurementExtractor = JsonPathMeasurementExtractor | ProtocolMeasurementExtractor;

export interface MeasurementProfileDefinition {
  name: string;
  title?: string;
  description: string;
  argv: string[];
  timeoutMs: number;
  /** Pin samples to one logical CPU from each selected physical core. */
  cpuAffinity?: { physicalCores: number };
  outputs: Record<string, { extract: NumericMeasurementExtractor }>;
  diagnostics?: {
    extract: DiagnosticMeasurementExtractor;
    schema: JsonSchema;
  };
  env?: Record<string, string>;
}

export interface MeasurementProfileRef extends MeasurementProfileDefinition {
  id: `${MeasurementProfileNamespace}:${string}`;
  namespace: MeasurementProfileNamespace;
  path: string;
  hash: string;
}

export type MeasurementProfileSnapshot = MeasurementProfileRef;

export interface InvalidMeasurementProfileRef {
  namespace: MeasurementProfileNamespace;
  path: string;
  name: string;
  error: string;
}

export interface MeasurementProfileRegistryRefreshOptions {
  /** Enable only after project trust has been established. */
  includeProject?: boolean;
  userDir?: string;
  projectDir?: string;
  builtins?: readonly MeasurementProfileDefinition[];
}

const PROFILE_FIELDS = new Set(["name", "title", "description", "argv", "timeoutMs", "cpuAffinity", "outputs", "diagnostics", "env"]);
const CPU_AFFINITY_FIELDS = new Set(["physicalCores"]);
const OUTPUT_FIELDS = new Set(["extract"]);
const DIAGNOSTIC_FIELDS = new Set(["extract", "schema"]);
const EXTRACTOR_FIELDS = new Set(["kind", "path", "pattern", "group", "flags"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Measurement authority is installed explicitly; there is no implicit executable evaluator. */
export const BUILTIN_MEASUREMENT_PROFILES: readonly MeasurementProfileDefinition[] = Object.freeze([]);

export class MeasurementProfileRegistry {
  private refs = new Map<string, MeasurementProfileRef>();
  private invalid: InvalidMeasurementProfileRef[] = [];

  async refresh(cwd: string, options: MeasurementProfileRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, MeasurementProfileRef>();
    const invalid: InvalidMeasurementProfileRef[] = [];
    const builtinEntries = (options.builtins ?? BUILTIN_MEASUREMENT_PROFILES).map((definition) => {
      try {
        return { ref: profileRef("builtin", `<builtin:${String(definition.name)}>`, definition) };
      } catch (error) {
        return { error: invalidRef("builtin", `<builtin:${String(definition.name)}>`, String(definition.name), error) };
      }
    });
    addNamespaceEntries("builtin", builtinEntries, refs, invalid);

    const roots: Array<{ namespace: "user" | "project"; dir: string }> = [
      { namespace: "user", dir: options.userDir ?? path.join(getAgentDir(), "measurements") },
    ];
    if (options.includeProject === true) {
      roots.push({
        namespace: "project",
        dir: options.projectDir ?? path.join(projectRoot(cwd), PROJECT_CONFIG_DIR_NAME, "measurements"),
      });
    }
    for (const root of roots) {
      const entries: Array<{ ref?: MeasurementProfileRef; error?: InvalidMeasurementProfileRef }> = [];
      let files: string[];
      try {
        files = await listJsonFiles(root.dir);
      } catch (error) {
        invalid.push(invalidRef(root.namespace, root.dir, "<registry>", error));
        continue;
      }
      for (const filePath of files) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Measurement profile must be a regular non-symlink file");
          const text = await readBoundedTextFile(filePath, DEFINITION_LIMITS.measurementProfileBytes);
          entries.push({ ref: profileRef(root.namespace, filePath, parseMeasurementProfile(text, filePath)) });
        } catch (error) {
          entries.push({ error: invalidRef(root.namespace, filePath, path.basename(filePath, ".json"), error) });
        }
      }
      addNamespaceEntries(root.namespace, entries, refs, invalid);
    }
    this.refs = refs;
    this.invalid = invalid;
  }

  list(): MeasurementProfileRef[] {
    return [...this.refs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listInvalid(): InvalidMeasurementProfileRef[] {
    return [...this.invalid].sort((left, right) => left.path.localeCompare(right.path));
  }

  get(id: string): MeasurementProfileRef | undefined {
    return this.refs.get(id);
  }

  resolve(selector: string): MeasurementProfileRef {
    return resolveMeasurementProfile(this.list(), selector);
  }
}

export function resolveMeasurementProfile(
  profiles: readonly MeasurementProfileSnapshot[],
  selector: string,
): MeasurementProfileSnapshot {
  if (typeof selector !== "string") throw new Error("Measurement profile selector must be a string");
  if (selector.includes(":")) {
    if (!/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(selector)) {
      throw new Error(`Invalid measurement profile selector ${selector}`);
    }
    const exact = profiles.find((profile) => profile.id === selector);
    if (!exact) throw new Error(`Unknown measurement profile ${selector}`);
    return deepFreezeJson(structuredClone(exact) as unknown as JsonValue) as unknown as MeasurementProfileSnapshot;
  }
  if (!FLOW_NAME_PATTERN.test(selector)) throw new Error(`Invalid measurement profile selector ${selector}`);
  const matches = profiles.filter((profile) => profile.name === selector);
  if (matches.length === 0) throw new Error(`Unknown measurement profile ${selector}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous measurement profile ${selector}; use one of ${matches.map((profile) => profile.id).join(", ")}`);
  }
  return deepFreezeJson(structuredClone(matches[0]!) as unknown as JsonValue) as unknown as MeasurementProfileSnapshot;
}

export function parseMeasurementProfile(text: string, filePath = "<profile>"): MeasurementProfileDefinition {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Measurement profile is not JSON: ${errorMessage(error)}`);
  }
  return normalizeMeasurementProfile(value, filePath);
}

export function normalizeMeasurementProfile(value: unknown, filePath = "<profile>"): MeasurementProfileDefinition {
  const profile = strictRecord(value, PROFILE_FIELDS, "measurement profile");
  const name = requiredBoundedString(profile.name, "measurement profile name", 64);
  if (!FLOW_NAME_PATTERN.test(name)) throw new Error("Measurement profile name must match ^[a-z][a-z0-9_-]{0,63}$");
  if (filePath !== "<profile>" && !filePath.startsWith("<builtin:") && path.basename(filePath, ".json") !== name) {
    throw new Error(`Measurement profile name ${name} must match filename ${path.basename(filePath, ".json")}`);
  }
  const title = optionalBoundedString(profile.title, "measurement profile title", 192);
  const description = requiredBoundedString(profile.description, "measurement profile description", 2_000);
  const argv = normalizeArgv(profile.argv);
  const timeoutMs = boundedInteger(profile.timeoutMs, "measurement timeoutMs", 1, DEFINITION_LIMITS.commandTimeoutMs);
  const cpuAffinity = normalizeCpuAffinity(profile.cpuAffinity);
  const outputsRecord = strictRecord(profile.outputs, undefined, "measurement outputs");
  const outputIds = Object.keys(outputsRecord).sort();
  if (outputIds.length < 1 || outputIds.length > DEFINITION_LIMITS.measurementOutputs) {
    throw new Error(`Measurement profile requires 1–${DEFINITION_LIMITS.measurementOutputs} outputs`);
  }
  const outputs: MeasurementProfileDefinition["outputs"] = {};
  for (const outputId of outputIds) {
    if (!FLOW_NAME_PATTERN.test(outputId)) throw new Error(`Invalid measurement output id ${outputId}`);
    const output = strictRecord(outputsRecord[outputId], OUTPUT_FIELDS, `measurement output ${outputId}`);
    outputs[outputId] = { extract: normalizeNumericExtractor(output.extract, `measurement output ${outputId}`) };
  }
  const diagnostics = profile.diagnostics === undefined
    ? undefined
    : normalizeDiagnostics(profile.diagnostics);
  const protocolKinds = [
    ...Object.values(outputs).map((output) => output.extract.kind),
    ...(diagnostics ? [diagnostics.extract.kind] : []),
  ];
  if (protocolKinds.includes("protocol") && protocolKinds.some((kind) => kind !== "protocol")) {
    throw new Error("Protocol measurement extraction cannot be mixed with JSON-path or regex extraction in one profile");
  }
  const env = normalizeEnvironment(profile.env);
  return deepFreezeJson(canonicalJsonObject({
    name,
    ...(title ? { title } : {}),
    description,
    argv,
    timeoutMs,
    ...(cpuAffinity ? { cpuAffinity } : {}),
    outputs,
    ...(diagnostics ? { diagnostics } : {}),
    ...(env ? { env } : {}),
  }, profileJsonLimits())) as unknown as MeasurementProfileDefinition;
}

function normalizeCpuAffinity(value: unknown): MeasurementProfileDefinition["cpuAffinity"] {
  if (value === undefined) return undefined;
  const affinity = strictRecord(value, CPU_AFFINITY_FIELDS, "measurement CPU affinity");
  return {
    physicalCores: boundedInteger(affinity.physicalCores, "measurement CPU affinity physicalCores", 1, 4_096),
  };
}

function normalizeDiagnostics(value: unknown): NonNullable<MeasurementProfileDefinition["diagnostics"]> {
  const diagnostics = strictRecord(value, DIAGNOSTIC_FIELDS, "measurement diagnostics");
  const extract = normalizeDiagnosticExtractor(diagnostics.extract, "measurement diagnostics");
  const schema = deepFreezeJson(canonicalJsonObject(diagnostics.schema, schemaLimits())) as JsonSchema;
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateSchema: true });
  if (!ajv.validateSchema(schema)) throw new Error(`Measurement diagnostic schema is invalid: ${ajv.errorsText(ajv.errors)}`);
  ajv.compile(schema);
  return { extract, schema };
}

function normalizeNumericExtractor(value: unknown, label: string): NumericMeasurementExtractor {
  const extractor = strictRecord(value, EXTRACTOR_FIELDS, `${label} extractor`);
  if (extractor.kind === "protocol") {
    assertExactKeys(extractor, new Set(["kind"]), `${label} protocol extractor`);
    return { kind: "protocol" };
  }
  if (extractor.kind === "json-path") {
    assertExactKeys(extractor, new Set(["kind", "path"]), `${label} JSON-path extractor`);
    const jsonPath = requiredBoundedString(extractor.path, `${label} JSON path`, 512);
    validateJsonPath(jsonPath);
    return { kind: "json-path", path: jsonPath };
  }
  if (extractor.kind === "regex") {
    assertExactKeys(extractor, new Set(["kind", "pattern", "group", "flags"]), `${label} regex extractor`, true);
    const pattern = requiredBoundedString(extractor.pattern, `${label} regex pattern`, 2_000);
    const flags = extractor.flags === undefined ? "" : extractor.flags;
    if (!["", "i", "m", "im"].includes(String(flags))) throw new Error(`${label} regex flags must be empty, i, m, or im`);
    const group = extractor.group;
    if (group !== undefined && !(
      (Number.isSafeInteger(group) && (group as number) >= 0 && (group as number) <= 64) ||
      (typeof group === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(group))
    )) throw new Error(`${label} regex group is invalid`);
    try {
      new RegExp(pattern, `${flags}u`);
    } catch (error) {
      throw new Error(`${label} regex is invalid: ${errorMessage(error)}`);
    }
    return { kind: "regex", pattern, ...(group !== undefined ? { group: group as number | string } : {}), flags: flags as RegexMeasurementExtractor["flags"] };
  }
  throw new Error(`${label} extractor kind must be protocol, json-path, or regex`);
}

function normalizeDiagnosticExtractor(value: unknown, label: string): DiagnosticMeasurementExtractor {
  const extractor = normalizeNumericExtractor(value, label);
  if (extractor.kind === "regex") throw new Error("Measurement diagnostics do not support regex extraction");
  return extractor;
}

function normalizeArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DEFINITION_LIMITS.commandArgv) {
    throw new Error(`Measurement argv must contain 1–${DEFINITION_LIMITS.commandArgv} arguments`);
  }
  return value.map((argument, index) => {
    if (
      typeof argument !== "string" || argument.includes("\0") ||
      Buffer.byteLength(argument) > DEFINITION_LIMITS.commandArgBytes || (index === 0 && argument.length === 0)
    ) throw new Error(`Measurement argv[${index}] is invalid`);
    return argument;
  });
}

function normalizeEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = strictRecord(value, undefined, "measurement environment");
  const keys = Object.keys(input).sort();
  if (keys.length > DEFINITION_LIMITS.commandEnv) throw new Error("Measurement environment has too many entries");
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_NAME.test(key)) throw new Error(`Invalid measurement environment key ${key}`);
    const entry = input[key];
    if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > DEFINITION_LIMITS.commandEnvValueBytes) {
      throw new Error(`Invalid measurement environment value ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

function profileRef(
  namespace: MeasurementProfileNamespace,
  filePath: string,
  definition: MeasurementProfileDefinition,
): MeasurementProfileRef {
  const normalized = normalizeMeasurementProfile(definition, filePath);
  return deepFreezeJson(canonicalJsonObject({
    ...normalized,
    id: `${namespace}:${normalized.name}`,
    namespace,
    path: filePath,
    hash: stableHash({ namespace, definition: normalized }),
  }, profileJsonLimits())) as unknown as MeasurementProfileRef;
}

function addNamespaceEntries(
  namespace: MeasurementProfileNamespace,
  entries: Array<{ ref?: MeasurementProfileRef; error?: InvalidMeasurementProfileRef }>,
  refs: Map<string, MeasurementProfileRef>,
  invalid: InvalidMeasurementProfileRef[],
): void {
  invalid.push(...entries.flatMap((entry) => entry.error ? [entry.error] : []));
  const groups = new Map<string, MeasurementProfileRef[]>();
  for (const ref of entries.flatMap((entry) => entry.ref ? [entry.ref] : [])) {
    groups.set(ref.name, [...(groups.get(ref.name) ?? []), ref]);
  }
  for (const [name, group] of groups) {
    if (group.length > 1) {
      for (const ref of group) invalid.push(invalidRef(namespace, ref.path, name, new Error(`Duplicate ${namespace} measurement profile ${name}`)));
      continue;
    }
    refs.set(group[0]!.id, group[0]!);
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe measurement profile directory ${directory}`);
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > DEFINITION_LIMITS.measurementProfileFilesPerNamespace) {
    throw new Error(`Measurement profile directory exceeds ${DEFINITION_LIMITS.measurementProfileFilesPerNamespace} entries`);
  }
  const files = entries.filter((entry) => entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name)).sort();
  if (files.length > DEFINITION_LIMITS.measurementProfileFilesPerNamespace) throw new Error("Too many measurement profile files");
  return files;
}

function strictRecord(value: unknown, allowed: Set<string> | undefined, label: string): Record<string, unknown> {
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

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  omitUndefined = false,
): void {
  for (const key of Object.keys(record)) {
    if (omitUndefined && record[key] === undefined) continue;
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
}

function requiredBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  if (Array.from(value).length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} exceeds ${maximum} Unicode scalars or contains control characters`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredBoundedString(value, label, maximum);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function validateJsonPath(value: string): void {
  if (value === "$" || /^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[(?:0|[1-9][0-9]*)\]))+$/.test(value)) return;
  throw new Error(`Unsupported JSON path ${value}; use $.field and [index] segments only`);
}

function invalidRef(
  namespace: MeasurementProfileNamespace,
  filePath: string,
  name: string,
  error: unknown,
): InvalidMeasurementProfileRef {
  return { namespace, path: filePath, name, error: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileJsonLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.measurementProfileBytes,
    maxDepth: DEFINITION_LIMITS.schemaDepth,
    maxNodes: DEFINITION_LIMITS.schemaNodes,
    maxStringScalars: DEFINITION_LIMITS.agentPromptScalars,
  };
}

function schemaLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.schemaBytes,
    maxDepth: DEFINITION_LIMITS.schemaDepth,
    maxNodes: DEFINITION_LIMITS.schemaNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}
