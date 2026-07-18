import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import type { MeasurementProfileSnapshot } from "../measurements/profiles.js";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { parseWorkflow } from "../definition/workflow-frontend.js";
import { collectWorkflowSchemaResources } from "../definition/workflow-schema.js";
import {
  WORKFLOW_RUNTIME_API_DESCRIPTOR,
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_RUNTIME_API_VERSION,
  type WorkflowResourceIdentity,
} from "../definition/workflow-language.js";
import type {
  ParsedWorkflow,
  WorkflowDescriptor,
  WorkflowDynamicResourceUse,
  WorkflowReview,
  WorkflowSourceTransform,
} from "../definition/workflow-types.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  workflowDefinitionHash,
  type WorkflowDefinitionRef,
  type WorkflowId,
} from "../registry/structured-workflows.js";
import type {
  WorkflowExposure,
  WorkflowRegistryPolicySnapshot,
} from "../registry/workflow-policy.js";
import { workflowExposure } from "../registry/workflow-policy.js";

export type WorkflowLaunchAuthority = "model" | "user" | "rpc";

export interface WorkflowMetricOutputBinding {
  output: string;
  role: "primary" | "guardrail" | "observe";
}

export interface WorkflowMeasurementResourceUse {
  operationSite: string;
  metricPolicyPath: string;
  samplingPath?: string;
  policy: JsonObject;
  sampling?: JsonObject;
  outputs: WorkflowMetricOutputBinding[];
}

export interface WorkflowMeasurementResourceBinding {
  formatVersion: 1;
  identity: WorkflowResourceIdentity & { kind: "measurement-profile" };
  inputPath: string;
  profile: MeasurementProfileSnapshot;
  uses: WorkflowMeasurementResourceUse[];
  bindingHash: string;
}

export interface PersistedWorkflowInvocation {
  formatVersion: 1;
  workflowId: WorkflowId;
  namespace: "builtin" | "user" | "project";
  name: string;
  title?: string;
  description: string;
  concurrency?: number;
  exposure: WorkflowExposure;
  launch: {
    authority: WorkflowLaunchAuthority;
    policyHash: string;
    projectTrusted: boolean;
  };
  runtimeApiVersion: 17;
  runtimeApiHash: string;
  sourceHash: string;
  executableSourceHash: string;
  definitionHash: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  descriptors: WorkflowDescriptor[];
  review: WorkflowReview;
  transform: WorkflowSourceTransform;
  input: JsonObject;
  inputHash: string;
  resourcesHash: string;
  installedPath: string;
  snapshotHash: string;
}

export interface WorkflowInvocationSnapshot extends PersistedWorkflowInvocation {
  source: string;
  executableSource: string;
  policy: WorkflowRegistryPolicySnapshot;
  resources: WorkflowMeasurementResourceBinding[];
}

export interface CreateWorkflowInvocationOptions {
  authority: WorkflowLaunchAuthority;
  projectTrusted?: boolean;
  measurementProfiles?: { resolve(selector: string): MeasurementProfileSnapshot };
}

export interface WorkflowInvocationFilesystemPaths {
  root: string;
  source: string;
  executable: string;
  context: string;
  invocation: string;
  policy: string;
  resources: string;
  runtimeApi: string;
}

const SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;
const EXECUTABLE_BYTES = 2 * 1024 * 1024;

export function createWorkflowInvocationSnapshot(
  ref: WorkflowDefinitionRef,
  args: unknown,
  options: CreateWorkflowInvocationOptions,
): WorkflowInvocationSnapshot {
  if (ref.namespace === "project" && options.projectTrusted !== true) {
    throw new Error(`Project workflow ${ref.id} requires project trust`);
  }
  if (options.authority === "model" && ref.exposure !== "model") {
    throw new Error(`Workflow ${ref.id} is human-only under registry policy ${ref.policy.hash}`);
  }
  const input = canonicalJsonObject(args, invocationLimits());
  validateInvocationInput(ref.id, ref.input, input);
  const resources = prepareInvocationResources(
    ref.parsed,
    input,
    options.measurementProfiles,
    options.projectTrusted === true,
  );
  const resourcesHash = stableHash(resources);
  const persisted = persistedInvocationBody(
    ref,
    input,
    resourcesHash,
    options.authority,
    options.projectTrusted === true,
  );
  const snapshot: WorkflowInvocationSnapshot = {
    ...persisted,
    snapshotHash: stableHash(persisted),
    source: ref.source,
    executableSource: ref.parsed.executableSource,
    policy: ref.policy,
    resources,
  };
  assertWorkflowInvocationSnapshot(snapshot);
  return deepFreezeJson(snapshot as unknown as JsonValue) as unknown as WorkflowInvocationSnapshot;
}

export function workflowInvocationFilesystemPaths(
  runDirInput: string,
): WorkflowInvocationFilesystemPaths {
  const root = path.resolve(runDirInput);
  const context = path.join(root, "context");
  return Object.freeze({
    root,
    source: path.join(root, "source.flow.ts"),
    executable: path.join(context, "executable.js"),
    context,
    invocation: path.join(context, "invocation.json"),
    policy: path.join(context, "registry-policy.json"),
    resources: path.join(context, "invocation-resources.json"),
    runtimeApi: path.join(context, "runtime-api.json"),
  });
}

/** Atomically create one standalone immutable v17 invocation snapshot directory. */
export async function writeWorkflowInvocationSnapshot(
  runDirInput: string,
  snapshot: WorkflowInvocationSnapshot,
): Promise<void> {
  assertWorkflowInvocationSnapshot(snapshot);
  validateSnapshotAgainstSource(snapshot);
  const paths = workflowInvocationFilesystemPaths(runDirInput);
  const parent = path.dirname(paths.root);
  await fs.promises.mkdir(parent, { recursive: true });
  await assertDirectory(parent, "Workflow v17 snapshot parent");
  try {
    await fs.promises.lstat(paths.root);
    throw existsError(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.${path.basename(paths.root)}.v17-${process.pid}-${crypto.randomUUID()}`);
  const temporaryPaths = workflowInvocationFilesystemPaths(temporary);
  await fs.promises.mkdir(temporaryPaths.context, { recursive: true, mode: 0o700 });
  const persisted = persistedFromSnapshot(snapshot);
  try {
    await Promise.all([
      writeExclusive(temporaryPaths.source, snapshot.source),
      writeExclusive(temporaryPaths.executable, snapshot.executableSource),
      writeExclusive(temporaryPaths.invocation, `${stableJson(persisted)}\n`),
      writeExclusive(temporaryPaths.policy, `${stableJson(snapshot.policy)}\n`),
      writeExclusive(temporaryPaths.resources, `${stableJson(snapshot.resources)}\n`),
      writeExclusive(temporaryPaths.runtimeApi, `${stableJson({
        version: WORKFLOW_RUNTIME_API_VERSION,
        hash: WORKFLOW_RUNTIME_API_HASH,
        descriptor: WORKFLOW_RUNTIME_API_DESCRIPTOR,
      })}\n`),
    ]);
    await syncDirectory(temporaryPaths.context);
    await syncDirectory(temporaryPaths.root);
    await fs.promises.rename(temporaryPaths.root, paths.root);
    await syncDirectory(parent);
  } catch (error) {
    await fs.promises.rm(temporaryPaths.root, { recursive: true, force: true }).catch(() => undefined);
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw existsError(paths.root);
    throw error;
  }
}

/** Read and independently reconstruct a snapshotted definition without consulting the live registry. */
export async function readWorkflowInvocationSnapshot(
  runDirInput: string,
): Promise<WorkflowInvocationSnapshot> {
  const paths = workflowInvocationFilesystemPaths(runDirInput);
  await assertDirectory(paths.root, "Workflow v17 snapshot root");
  await assertDirectory(paths.context, "Workflow v17 snapshot context");
  const [source, executableSource, persisted, policy, resources, runtimeApi] = await Promise.all([
    readText(paths.source, DEFINITION_LIMITS.sourceBytes),
    readText(paths.executable, EXECUTABLE_BYTES),
    readCanonicalJson<PersistedWorkflowInvocation>(paths.invocation, SNAPSHOT_JSON_BYTES),
    readCanonicalJson<WorkflowRegistryPolicySnapshot>(paths.policy, SNAPSHOT_JSON_BYTES),
    readCanonicalJson<WorkflowMeasurementResourceBinding[]>(paths.resources, SNAPSHOT_JSON_BYTES),
    readCanonicalJson<unknown>(paths.runtimeApi, SNAPSHOT_JSON_BYTES),
  ]);
  assertRuntimeApi(runtimeApi);
  const snapshot = {
    ...persisted,
    source,
    executableSource,
    policy,
    resources,
  } as WorkflowInvocationSnapshot;
  assertWorkflowInvocationSnapshot(snapshot);
  validateSnapshotAgainstSource(snapshot);
  return deepFreezeJson(snapshot as unknown as JsonValue) as unknown as WorkflowInvocationSnapshot;
}

export function assertWorkflowInvocationSnapshot(
  snapshot: WorkflowInvocationSnapshot,
): void {
  if (snapshot.formatVersion !== 1 || snapshot.runtimeApiVersion !== WORKFLOW_RUNTIME_API_VERSION
    || snapshot.runtimeApiHash !== WORKFLOW_RUNTIME_API_HASH) {
    throw new Error("Workflow v17 invocation uses another language revision");
  }
  if (!FLOW_NAME_PATTERN.test(snapshot.name)
    || snapshot.workflowId !== `${snapshot.namespace}:${snapshot.name}`) {
    throw new Error("Workflow v17 invocation identity is invalid");
  }
  if (path.basename(snapshot.installedPath) !== `${snapshot.name}.flow.ts`) {
    throw new Error("Workflow v17 installed path does not match its identity");
  }
  if (snapshot.exposure !== "human" && snapshot.exposure !== "model") {
    throw new Error("Workflow v17 invocation exposure is invalid");
  }
  exactKeys(snapshot.launch, ["authority", "policyHash", "projectTrusted"], "Workflow v17 launch binding");
  if (!["model", "user", "rpc"].includes(snapshot.launch.authority)) {
    throw new Error("Workflow v17 invocation launch authority is invalid");
  }
  if (typeof snapshot.launch.projectTrusted !== "boolean") {
    throw new Error("Workflow v17 invocation project trust is invalid");
  }
  if (snapshot.namespace === "project" && !snapshot.launch.projectTrusted) {
    throw new Error("A project workflow snapshot requires project trust");
  }
  if (snapshot.launch.authority === "model" && snapshot.exposure !== "model") {
    throw new Error("A model launch cannot use a human-only workflow snapshot");
  }
  if (sha256(snapshot.source) !== snapshot.sourceHash
    || sha256(snapshot.executableSource) !== snapshot.executableSourceHash
    || snapshot.transform.sourceHash !== snapshot.sourceHash
    || snapshot.transform.executableSourceHash !== snapshot.executableSourceHash
    || snapshot.transform.runtimeApiHash !== WORKFLOW_RUNTIME_API_HASH) {
    throw new Error("Workflow v17 invocation source transform is corrupt");
  }
  assertPolicy(snapshot.policy, snapshot.namespace, snapshot.launch.policyHash);
  if (workflowExposure(snapshot.policy, snapshot.name) !== snapshot.exposure) {
    throw new Error("Workflow v17 invocation exposure differs from its policy snapshot");
  }
  assertResourceBindings(snapshot.resources);
  if (stableHash(snapshot.resources) !== snapshot.resourcesHash) {
    throw new Error("Workflow v17 invocation resource hash is corrupt");
  }
  if (stableHash(snapshot.input) !== snapshot.inputHash) {
    throw new Error("Workflow v17 invocation input hash is corrupt");
  }
  validateInvocationInput(snapshot.workflowId, snapshot.inputSchema, snapshot.input);
  const persisted = persistedFromSnapshot(snapshot);
  const { snapshotHash: _snapshotHash, ...body } = persisted;
  if (stableHash(body) !== snapshot.snapshotHash) {
    throw new Error("Workflow v17 invocation snapshot hash is corrupt");
  }
}

function persistedInvocationBody(
  ref: WorkflowDefinitionRef,
  input: JsonObject,
  resourcesHash: string,
  authority: WorkflowLaunchAuthority,
  projectTrusted: boolean,
): Omit<PersistedWorkflowInvocation, "snapshotHash"> {
  return {
    formatVersion: 1,
    workflowId: ref.id,
    namespace: ref.namespace,
    name: ref.name,
    ...(ref.title ? { title: ref.title } : {}),
    description: ref.description,
    ...(ref.concurrency !== undefined ? { concurrency: ref.concurrency } : {}),
    exposure: ref.exposure,
    launch: { authority, policyHash: ref.policy.hash, projectTrusted },
    runtimeApiVersion: WORKFLOW_RUNTIME_API_VERSION,
    runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
    sourceHash: ref.sourceHash,
    executableSourceHash: ref.parsed.transform.executableSourceHash,
    definitionHash: ref.definitionHash,
    inputSchema: ref.input,
    outputSchema: ref.output,
    descriptors: ref.parsed.descriptors,
    review: ref.parsed.review,
    transform: ref.parsed.transform,
    input,
    inputHash: stableHash(input),
    resourcesHash,
    installedPath: ref.path,
  };
}

function persistedFromSnapshot(snapshot: WorkflowInvocationSnapshot): PersistedWorkflowInvocation {
  const {
    source: _source,
    executableSource: _executableSource,
    policy: _policy,
    resources: _resources,
    ...persisted
  } = snapshot;
  return persisted;
}

function prepareInvocationResources(
  parsed: ParsedWorkflow,
  input: JsonObject,
  profiles: CreateWorkflowInvocationOptions["measurementProfiles"],
  projectTrusted: boolean,
): WorkflowMeasurementResourceBinding[] {
  const declared = collectWorkflowSchemaResources(parsed.metadata.input);
  if (declared.length === 0) return [];
  if (!profiles) throw new Error("Invocation-selected measurement profiles require a trusted registry");
  const groups = new Map<string, WorkflowDynamicResourceUse[]>();
  const seenDeclarations = new Set<string>();
  for (const resource of declared) {
    if (resource.kind !== "measurement-profile") continue;
    const declarationKey = `${resource.kind}:${resource.inputPath}`;
    if (seenDeclarations.has(declarationKey)) continue;
    seenDeclarations.add(declarationKey);
    const uses = parsed.review.dynamicResources.filter((use) => use.inputPath === resource.inputPath);
    for (const concretePath of expandJsonPointer(input, resource.inputPath)) {
      groups.set(concretePath, [...(groups.get(concretePath) ?? []), ...uses]);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([inputPath, uses]) => {
    const selector = jsonPointer(input, inputPath);
    if (typeof selector !== "string") throw new Error(`Measurement profile input ${inputPath} is not a selector`);
    if (selector.startsWith("project:") && !projectTrusted) {
      throw new Error(`Project measurement profile ${selector} requires project trust`);
    }
    const profile = structuredClone(profiles.resolve(selector));
    assertMeasurementProfileSnapshot(profile, selector);
    const identity: WorkflowResourceIdentity & { kind: "measurement-profile" } = {
      formatVersion: 1,
      kind: "measurement-profile",
      selector,
      snapshotHash: profile.hash,
    };
    const resolvedUses = uses.sort((left, right) => left.operationSite.localeCompare(right.operationSite)).map((use) => {
      const policy = plainRecord(jsonPointer(input, use.metricPolicyPath!), `Metric policy ${use.metricPolicyPath!}`);
      const outputs = metricOutputBindings(policy, profile, use.metricPolicyPath!);
      const samplingValue = use.samplingPath ? jsonPointer(input, use.samplingPath) : undefined;
      const sampling = samplingValue === undefined
        ? undefined
        : plainRecord(samplingValue, `Metric sampling ${use.samplingPath!}`);
      return {
        operationSite: use.operationSite,
        metricPolicyPath: use.metricPolicyPath!,
        ...(use.samplingPath ? { samplingPath: use.samplingPath } : {}),
        policy: structuredClone(policy) as JsonObject,
        ...(sampling ? { sampling: structuredClone(sampling) as JsonObject } : {}),
        outputs,
      };
    });
    const body = { formatVersion: 1 as const, identity, inputPath, profile, uses: resolvedUses };
    return { ...body, bindingHash: stableHash(body) };
  });
}

function metricOutputBindings(
  value: unknown,
  profile: MeasurementProfileSnapshot,
  inputPath: string,
): WorkflowMetricOutputBinding[] {
  const policy = plainRecord(value, `Metric policy ${inputPath}`);
  const primary = plainRecord(policy.primary, `Metric policy ${inputPath}.primary`);
  const result: WorkflowMetricOutputBinding[] = [metricOutput(primary, "primary", profile)];
  for (const [field, role] of [["guardrails", "guardrail"], ["observe", "observe"]] as const) {
    const entries = policy[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Metric policy ${inputPath}.${field} must be an array`);
    for (const entry of entries) result.push(metricOutput(
      plainRecord(entry, `Metric policy ${inputPath}.${field}`),
      role,
      profile,
    ));
  }
  const seen = new Set<string>();
  for (const binding of result) {
    if (seen.has(binding.output)) throw new Error(`Duplicate optimization output ${binding.output}`);
    seen.add(binding.output);
  }
  return result;
}

function metricOutput(
  policy: Record<string, unknown>,
  role: WorkflowMetricOutputBinding["role"],
  profile: MeasurementProfileSnapshot,
): WorkflowMetricOutputBinding {
  const output = policy.output;
  if (typeof output !== "string" || !Object.hasOwn(profile.outputs, output)) {
    throw new Error(`Measurement profile ${profile.id} has no output ${String(output)}`);
  }
  return { output, role };
}

function assertMeasurementProfileSnapshot(profile: MeasurementProfileSnapshot, selector: string): void {
  if (!profile || typeof profile !== "object" || profile.id !== selector || typeof profile.hash !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(profile.hash) || !profile.outputs || typeof profile.outputs !== "object") {
    throw new Error(`Trusted measurement registry returned an invalid snapshot for ${selector}`);
  }
  const { id, namespace, path: profilePath, hash, ...definition } = profile;
  if (id !== `${namespace}:${definition.name}` || typeof profilePath !== "string"
    || stableHash({ namespace, definition }) !== hash) {
    throw new Error(`Measurement profile ${selector} snapshot hash is invalid`);
  }
}

function assertResourceBindings(resources: readonly WorkflowMeasurementResourceBinding[]): void {
  if (!Array.isArray(resources)) throw new Error("Workflow v17 invocation resources must be an array");
  const paths = new Set<string>();
  for (const resource of resources) {
    if (resource.formatVersion !== 1 || resource.identity?.kind !== "measurement-profile"
      || resource.identity.selector !== resource.profile?.id
      || resource.identity.snapshotHash !== resource.profile?.hash
      || typeof resource.inputPath !== "string" || paths.has(resource.inputPath)) {
      throw new Error("Workflow v17 invocation resource identity is invalid");
    }
    paths.add(resource.inputPath);
    assertMeasurementProfileSnapshot(resource.profile, resource.identity.selector);
    const { bindingHash, ...body } = resource;
    if (stableHash(body) !== bindingHash) throw new Error(`Workflow v17 resource ${resource.inputPath} hash is corrupt`);
  }
}

function assertPolicy(
  policy: WorkflowRegistryPolicySnapshot,
  namespace: PersistedWorkflowInvocation["namespace"],
  expectedHash: string,
): void {
  exactKeys(
    policy as unknown as Record<string, unknown>,
    ["formatVersion", "namespace", "path", "source", "model", "hash"],
    "Workflow v17 registry policy snapshot",
  );
  if (policy.formatVersion !== 1 || policy.namespace !== namespace || !Array.isArray(policy.model)
    || typeof policy.path !== "string" || !path.isAbsolute(policy.path)
    || (policy.source !== "default" && policy.source !== "file")) {
    throw new Error("Workflow v17 registry policy snapshot is invalid");
  }
  const model = [...policy.model].sort();
  if (model.some((name, index) => !FLOW_NAME_PATTERN.test(name) || (index > 0 && model[index - 1] === name))) {
    throw new Error("Workflow v17 registry policy model entries are invalid");
  }
  if (model.some((name, index) => policy.model[index] !== name)) {
    throw new Error("Workflow v17 registry policy model entries are not canonical");
  }
  const hash = stableHash({ formatVersion: 1, namespace, model });
  if (policy.hash !== hash || expectedHash !== hash) throw new Error("Workflow v17 registry policy hash is corrupt");
}

function assertSnapshotFrontend(
  snapshot: WorkflowInvocationSnapshot,
  parsed: ParsedWorkflow,
): void {
  if (parsed.installedName !== snapshot.name || parsed.sourceHash !== snapshot.sourceHash
    || parsed.executableSource !== snapshot.executableSource
    || workflowDefinitionHash(snapshot.workflowId, parsed) !== snapshot.definitionHash
    || parsed.metadata.title !== snapshot.title
    || parsed.metadata.description !== snapshot.description
    || parsed.metadata.concurrency !== snapshot.concurrency
    || stableHash(parsed.metadata.input) !== stableHash(snapshot.inputSchema)
    || stableHash(parsed.metadata.output) !== stableHash(snapshot.outputSchema)
    || stableHash(parsed.descriptors) !== stableHash(snapshot.descriptors)
    || stableHash(parsed.review) !== stableHash(snapshot.review)
    || stableHash(parsed.transform) !== stableHash(snapshot.transform)) {
    throw new Error("Workflow v17 invocation differs from its exact source review");
  }
}

function validateSnapshotAgainstSource(snapshot: WorkflowInvocationSnapshot): void {
  const parsed = parseWorkflow(snapshot.source, { fileName: `${snapshot.name}.flow.ts` });
  assertSnapshotFrontend(snapshot, parsed);
  const expectedResources = prepareInvocationResources(
    parsed,
    snapshot.input,
    resourceResolver(snapshot.resources),
    snapshot.launch.projectTrusted,
  );
  if (stableHash(expectedResources) !== stableHash(snapshot.resources)) {
    throw new Error("Workflow v17 invocation resources differ from source review and input");
  }
}

function resourceResolver(resources: readonly WorkflowMeasurementResourceBinding[]) {
  const profiles = new Map(resources.map((resource) => [resource.identity.selector, resource.profile]));
  return {
    resolve(selector: string): MeasurementProfileSnapshot {
      const profile = profiles.get(selector);
      if (!profile) throw new Error(`Workflow v17 invocation did not pin measurement profile ${selector}`);
      return structuredClone(profile);
    },
  };
}

function persistedInvocationKeys(value: PersistedWorkflowInvocation): string[] {
  return [
    "formatVersion", "workflowId", "namespace", "name", ...(value.title === undefined ? [] : ["title"]),
    "description", ...(value.concurrency === undefined ? [] : ["concurrency"]),
    "exposure", "launch", "runtimeApiVersion", "runtimeApiHash", "sourceHash",
    "executableSourceHash", "definitionHash", "inputSchema", "outputSchema", "descriptors", "review",
    "transform", "input", "inputHash", "resourcesHash", "installedPath", "snapshotHash",
  ];
}

function validateInvocationInput(workflowId: string, schema: JsonSchema, input: JsonObject): void {
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(input)) throw new Error(`Invalid arguments for ${workflowId}: ${ajv.errorsText(validate.errors)}`);
}

function persistedShape(value: unknown): asserts value is PersistedWorkflowInvocation {
  const record = plainRecord(value, "Workflow v17 persisted invocation");
  const expected = persistedInvocationKeys(record as unknown as PersistedWorkflowInvocation).sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Workflow v17 persisted invocation contains unexpected fields");
  }
}

function assertRuntimeApi(value: unknown): void {
  const record = plainRecord(value, "Workflow v17 runtime API snapshot");
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "descriptor,hash,version"
    || record.version !== WORKFLOW_RUNTIME_API_VERSION
    || record.hash !== WORKFLOW_RUNTIME_API_HASH
    || stableHash(record.descriptor) !== WORKFLOW_RUNTIME_API_HASH) {
    throw new Error("Workflow v17 runtime API snapshot is invalid");
  }
}

function jsonPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "/") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: JsonValue | undefined = root;
  for (const encoded of pointer.slice(1).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[encoded.replace(/~1/gu, "/").replace(/~0/gu, "~")];
  }
  return current;
}

function expandJsonPointer(root: JsonValue, pointer: string): string[] {
  if (!pointer.includes("/*")) return jsonPointer(root, pointer) === undefined ? [] : [pointer];
  const segments = pointer.slice(1).split("/");
  const result: string[] = [];
  const visit = (value: JsonValue | undefined, index: number, resolved: string[]): void => {
    if (index === segments.length) {
      result.push(`/${resolved.join("/")}`);
      return;
    }
    const segment = segments[index]!;
    if (value === undefined) return;
    if (segment === "*") {
      if (!Array.isArray(value)) throw new Error(`Invocation resource path ${pointer} does not name an array`);
      for (let item = 0; item < value.length; item++) visit(value[item], index + 1, [...resolved, String(item)]);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invocation resource path ${pointer} is unavailable`);
    }
    visit(
      (value as JsonObject)[segment.replace(/~1/gu, "/").replace(/~0/gu, "~")],
      index + 1,
      [...resolved, segment],
    );
  };
  visit(root, 0, []);
  return result;
}

function invocationLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.invocationBytes,
    maxDepth: DEFINITION_LIMITS.invocationDepth,
    maxNodes: DEFINITION_LIMITS.invocationNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}

async function readCanonicalJson<T>(filePath: string, maximumBytes: number): Promise<T> {
  const source = await readText(filePath, maximumBytes);
  const value = JSON.parse(source) as unknown;
  if (source !== `${stableJson(value)}\n`) throw new Error(`Workflow v17 snapshot file is not canonical: ${filePath}`);
  if (filePath.endsWith("invocation.json")) persistedShape(value);
  return value as T;
}

async function readText(filePath: string, maximumBytes: number): Promise<string> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`Unsafe workflow v17 snapshot file ${filePath}`);
  }
  return await fs.promises.readFile(filePath, "utf8");
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
}

function existsError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`Workflow v17 invocation snapshot already exists: ${filePath}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unexpected fields`);
  }
}
