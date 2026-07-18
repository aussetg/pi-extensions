import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowNamespace } from "../definition/types.js";
import {
  parseTypecheckedWorkflow,
  WORKFLOW_FRONTEND_REVISION,
} from "../definition/workflow-frontend.js";
import {
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_SOURCE_EXTENSION,
} from "../definition/workflow-language.js";
import {
  typecheckWorkflowSources,
  validateWorkflowTypeScriptEnvelope,
  workflowTypecheckApiPath,
  WORKFLOW_TYPECHECK_IDENTITY,
} from "../definition/workflow-typecheck.js";
import type {
  ParsedWorkflow,
  WorkflowSourceLocation,
} from "../definition/workflow-types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { projectWorkflowDir, userWorkflowDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import {
  defaultWorkflowRegistryPolicy,
  readWorkflowRegistryPolicy,
  WorkflowRegistryPromotionPendingError,
  WORKFLOW_REGISTRY_PROMOTION_FILE,
  workflowExposure,
  type WorkflowExposure,
  type WorkflowRegistryPolicySnapshot,
} from "./workflow-policy.js";

export type WorkflowId = `${WorkflowNamespace}:${string}`;

export interface WorkflowDefinitionRef {
  id: WorkflowId;
  namespace: WorkflowNamespace;
  name: string;
  title?: string;
  description: string;
  input: import("../types.js").JsonSchema;
  output: import("../types.js").JsonSchema;
  concurrency?: number;
  exposure: WorkflowExposure;
  policy: WorkflowRegistryPolicySnapshot;
  path: string;
  source: string;
  sourceHash: string;
  definitionHash: string;
  parsed: ParsedWorkflow;
}

export interface InvalidWorkflowDefinitionRef {
  kind: "definition" | "policy";
  namespace: WorkflowNamespace;
  path: string;
  name: string;
  error: string;
  location?: WorkflowSourceLocation;
}

export interface WorkflowRegistryRefreshOptions {
  includeProject?: boolean;
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
  apiPath?: string;
}

interface RegistryRoot {
  namespace: WorkflowNamespace;
  directory: string;
}

interface WorkflowSourceCandidate {
  filePath: string;
  installedName: string;
  source: string;
  sourceHash: string;
}

interface WorkflowRootScan {
  root: RegistryRoot;
  directory: string;
  policy?: WorkflowRegistryPolicySnapshot;
  fallbackPolicy: boolean;
  candidates: WorkflowSourceCandidate[];
  invalid: InvalidWorkflowDefinitionRef[];
}

interface WorkflowFrontendPlan {
  apiPath: string;
  apiSource: string;
  apiError?: unknown;
  cached: ReadonlyMap<string, ParsedWorkflow>;
  cacheKeys: ReadonlyMap<string, string>;
  misses: WorkflowSourceCandidate[];
}

interface WorkflowFrontendCacheEntry {
  parsed: ParsedWorkflow;
  bytes: number;
}

interface WorkflowFrontendCacheStore {
  formatVersion: 1;
  bytes: number;
  entries: Map<string, WorkflowFrontendCacheEntry>;
}

const FRONTEND_CACHE_FORMAT_VERSION = 1;
const FRONTEND_CACHE_MAX_ENTRIES = 512;
const FRONTEND_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const FRONTEND_CACHE_SYMBOL = Symbol.for("pi.workflows.frontend-cache");

/** Filesystem registry for reviewed TypeScript workflow definitions. */
export class WorkflowRegistry {
  private refs = new Map<string, WorkflowDefinitionRef>();
  private invalid: InvalidWorkflowDefinitionRef[] = [];

  async refresh(cwd: string, options: WorkflowRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, WorkflowDefinitionRef>();
    const invalid: InvalidWorkflowDefinitionRef[] = [];
    const roots: RegistryRoot[] = [
      { namespace: "builtin", directory: options.builtinDir ?? workflowBuiltinsDir() },
      { namespace: "user", directory: options.userDir ?? userWorkflowDir() },
    ];
    if (options.includeProject !== false) {
      roots.push({ namespace: "project", directory: options.projectDir ?? projectWorkflowDir(cwd) });
    }

    const scans: WorkflowRootScan[] = [];
    for (const root of roots) scans.push(await scanWorkflowRoot(root));
    const candidates = scans.flatMap(scan => scan.candidates);
    const frontend = await planWorkflowFrontends(candidates, options.apiPath);
    const typecheckErrors = batchTypecheckErrors(frontend.misses, frontend);

    for (const scan of scans) {
      const discovered = await materializeWorkflowRoot(scan, frontend, typecheckErrors);
      invalid.push(...discovered.invalid);
      for (const ref of discovered.refs) refs.set(ref.id, ref);
    }
    this.refs = refs;
    this.invalid = invalid.sort(compareInvalidRefs);
  }

  list(): WorkflowDefinitionRef[] {
    return [...this.refs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listInvalid(): InvalidWorkflowDefinitionRef[] {
    return [...this.invalid];
  }

  get(id: string): WorkflowDefinitionRef | undefined {
    if (id.includes(":")) return this.refs.get(id);
    const matches = this.list().filter((ref) => ref.name === id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolve(id: string): WorkflowDefinitionRef {
    if (id.includes(":")) {
      const ref = this.refs.get(id);
      if (!ref) throw new Error(`Unknown workflow definition: ${id}`);
      return ref;
    }
    const matches = this.list().filter((ref) => ref.name === id);
    if (matches.length === 0) throw new Error(`Unknown workflow definition: ${id}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous workflow definition ${id}; use one of: ${matches.map((ref) => ref.id).join(", ")}`);
    }
    return matches[0]!;
  }
}

export function workflowDefinitionHash(
  workflowId: WorkflowId,
  parsed: ParsedWorkflow,
): string {
  return stableHash({
    workflowId,
    sourceHash: parsed.sourceHash,
    runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
    metadata: parsed.metadata,
    descriptors: parsed.descriptors,
    review: parsed.review,
    transform: parsed.transform,
  });
}

async function scanWorkflowRoot(root: RegistryRoot): Promise<WorkflowRootScan> {
  const directory = path.resolve(root.directory);
  const empty = (invalid: InvalidWorkflowDefinitionRef[] = []): WorkflowRootScan => ({
    root,
    directory,
    fallbackPolicy: false,
    candidates: [],
    invalid,
  });
  let names: string[];
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Workflow registry root must be a regular non-symlink directory");
    }
    names = (await fs.promises.readdir(directory))
      .filter((name) => name.endsWith(WORKFLOW_SOURCE_EXTENSION))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    return empty([{
      kind: "definition",
      namespace: root.namespace,
      path: directory,
      name: path.basename(directory),
      error: errorMessage(error),
    }]);
  }
  if (names.length > DEFINITION_LIMITS.filesPerNamespace) {
    return empty([{
      kind: "definition",
      namespace: root.namespace,
      path: directory,
      name: path.basename(directory),
      error: `Too many ${WORKFLOW_SOURCE_EXTENSION} files (${names.length}/${DEFINITION_LIMITS.filesPerNamespace})`,
    }]);
  }

  let policy: WorkflowRegistryPolicySnapshot;
  let fallbackPolicy = false;
  const invalid: InvalidWorkflowDefinitionRef[] = [];
  try {
    policy = await readWorkflowRegistryPolicy(directory, root.namespace);
  } catch (error) {
    if (error instanceof WorkflowRegistryPromotionPendingError) {
      return empty([{
        kind: "policy",
        namespace: root.namespace,
        path: error.transactionPath,
        name: "registry",
        error: error.message,
      }]);
    }
    fallbackPolicy = true;
    policy = defaultWorkflowRegistryPolicy(directory, root.namespace);
    invalid.push({
      kind: "policy",
      namespace: root.namespace,
      path: path.join(directory, "registry.json"),
      name: "registry",
      error: errorMessage(error),
    });
  }

  const candidates: WorkflowSourceCandidate[] = [];
  const installedNames = new Set(names.map((name) => name.slice(0, -WORKFLOW_SOURCE_EXTENSION.length)));
  for (const exposed of policy.model) {
    if (!installedNames.has(exposed)) {
      invalid.push({
        kind: "policy",
        namespace: root.namespace,
        path: policy.path,
        name: exposed,
        error: `Workflow registry policy names missing definition ${exposed}${WORKFLOW_SOURCE_EXTENSION}`,
      });
    }
  }

  for (const name of names) {
    const filePath = path.join(directory, name);
    const installedName = name.slice(0, -WORKFLOW_SOURCE_EXTENSION.length);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Workflow definition must be a regular non-symlink file");
      }
      const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes);
      validateWorkflowTypeScriptEnvelope(source, filePath);
      candidates.push({ filePath, installedName, source, sourceHash: sha256(source) });
    } catch (error) {
      invalid.push(invalidDefinition(root.namespace, filePath, installedName, error));
    }
  }
  return { root, directory, policy, fallbackPolicy, candidates, invalid };
}

async function planWorkflowFrontends(
  candidates: readonly WorkflowSourceCandidate[],
  apiPathInput: string | undefined,
): Promise<WorkflowFrontendPlan> {
  const apiPath = workflowTypecheckApiPath(apiPathInput);
  let apiSource = "";
  try {
    if (candidates.length > 0) {
      apiSource = await readBoundedTextFile(apiPath, DEFINITION_LIMITS.sourceBytes);
    }
  } catch (apiError) {
    return {
      apiPath,
      apiSource,
      apiError,
      cached: new Map(),
      cacheKeys: new Map(),
      misses: [...candidates],
    };
  }
  const environmentHash = stableHash({
    cacheFormatVersion: FRONTEND_CACHE_FORMAT_VERSION,
    frontendRevision: WORKFLOW_FRONTEND_REVISION,
    runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
    workflowApiSourceHash: sha256(apiSource),
    typecheck: WORKFLOW_TYPECHECK_IDENTITY,
  });
  const cached = new Map<string, ParsedWorkflow>();
  const cacheKeys = new Map<string, string>();
  const misses: WorkflowSourceCandidate[] = [];

  for (const candidate of candidates) {
    const candidatePath = path.resolve(candidate.filePath);
    const cacheKey = stableHash({
      environmentHash,
      fileName: path.basename(candidate.filePath),
      sourceHash: candidate.sourceHash,
    });
    cacheKeys.set(candidatePath, cacheKey);
    const parsed = readFrontendCache(cacheKey);
    if (parsed && cachedWorkflowMatches(parsed, candidate)) cached.set(candidatePath, parsed);
    else {
      if (parsed) deleteFrontendCache(cacheKey);
      misses.push(candidate);
    }
  }
  return { apiPath, apiSource, cached, cacheKeys, misses };
}

function batchTypecheckErrors(
  candidates: readonly WorkflowSourceCandidate[],
  frontend: Pick<WorkflowFrontendPlan, "apiPath" | "apiSource" | "apiError">,
): ReadonlyMap<string, unknown> {
  if (frontend.apiError) {
    return new Map(candidates.map(candidate => [path.resolve(candidate.filePath), frontend.apiError]));
  }
  try {
    const results = typecheckWorkflowSources(
      candidates.map(candidate => ({ fileName: candidate.filePath, source: candidate.source })),
      { apiPath: frontend.apiPath, apiSource: frontend.apiSource },
    );
    return new Map(results.flatMap(result =>
      result.error ? [[path.resolve(result.fileName), result.error] as const] : []));
  } catch (error) {
    return new Map(candidates.map(candidate => [path.resolve(candidate.filePath), error]));
  }
}

async function materializeWorkflowRoot(
  scan: WorkflowRootScan,
  frontend: WorkflowFrontendPlan,
  typecheckErrors: ReadonlyMap<string, unknown>,
): Promise<{ refs: WorkflowDefinitionRef[]; invalid: InvalidWorkflowDefinitionRef[] }> {
  const { root, directory, policy, fallbackPolicy } = scan;
  const invalid = [...scan.invalid];
  if (!policy) return { refs: [], invalid };
  const refs: WorkflowDefinitionRef[] = [];

  for (const candidate of scan.candidates) {
    try {
      const candidatePath = path.resolve(candidate.filePath);
      const typecheckError = typecheckErrors.get(candidatePath);
      if (typecheckError) throw typecheckError;
      const cached = frontend.cached.get(candidatePath);
      const parsed = cached ?? parseTypecheckedWorkflow(candidate.source, {
        fileName: candidate.filePath,
      });
      if (parsed.installedName !== candidate.installedName) {
        throw new Error("Workflow frontend returned another installed name");
      }
      if (!cached) {
        const cacheKey = frontend.cacheKeys.get(candidatePath);
        if (cacheKey) writeFrontendCache(cacheKey, parsed);
      }
      const id = `${root.namespace}:${candidate.installedName}` as WorkflowId;
      const ref: WorkflowDefinitionRef = {
        id,
        namespace: root.namespace,
        name: candidate.installedName,
        ...(parsed.metadata.title ? { title: parsed.metadata.title } : {}),
        description: parsed.metadata.description,
        input: parsed.metadata.input,
        output: parsed.metadata.output,
        ...(parsed.metadata.concurrency !== undefined ? { concurrency: parsed.metadata.concurrency } : {}),
        exposure: workflowExposure(policy, candidate.installedName),
        policy,
        path: candidate.filePath,
        source: candidate.source,
        sourceHash: parsed.sourceHash,
        definitionHash: workflowDefinitionHash(id, parsed),
        parsed,
      };
      refs.push(Object.freeze(ref));
    } catch (error) {
      invalid.push(invalidDefinition(root.namespace, candidate.filePath, candidate.installedName, error));
    }
  }
  try {
    if (fallbackPolicy) {
      try {
        await fs.promises.lstat(path.join(directory, WORKFLOW_REGISTRY_PROMOTION_FILE));
        throw new WorkflowRegistryPromotionPendingError(
          path.join(directory, WORKFLOW_REGISTRY_PROMOTION_FILE),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { refs, invalid };
    }
    const finalPolicy = await readWorkflowRegistryPolicy(directory, root.namespace);
    if (finalPolicy.hash !== policy.hash) {
      return {
        refs: [],
        invalid: [{
          kind: "policy",
          namespace: root.namespace,
          path: finalPolicy.path,
          name: "registry",
          error: "Workflow registry policy changed during definition discovery; refresh again",
        }],
      };
    }
  } catch (error) {
    return {
      refs: [],
      invalid: [{
        kind: "policy",
        namespace: root.namespace,
        path: error instanceof WorkflowRegistryPromotionPendingError
          ? error.transactionPath
          : path.join(directory, "registry.json"),
        name: "registry",
        error: errorMessage(error),
      }],
    };
  }
  return { refs, invalid };
}

function cachedWorkflowMatches(parsed: ParsedWorkflow, candidate: WorkflowSourceCandidate): boolean {
  try {
    return parsed.fileName === path.basename(candidate.filePath)
      && parsed.installedName === candidate.installedName
      && parsed.source === candidate.source
      && parsed.sourceHash === candidate.sourceHash
      && parsed.transform.sourceHash === candidate.sourceHash
      && parsed.transform.runtimeApiHash === WORKFLOW_RUNTIME_API_HASH;
  } catch {
    return false;
  }
}

function frontendCacheStore(): WorkflowFrontendCacheStore {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = scope[FRONTEND_CACHE_SYMBOL] as WorkflowFrontendCacheStore | undefined;
  if (existing?.formatVersion === FRONTEND_CACHE_FORMAT_VERSION
    && existing.entries instanceof Map
    && Number.isSafeInteger(existing.bytes)
    && existing.bytes >= 0) return existing;
  const created: WorkflowFrontendCacheStore = {
    formatVersion: FRONTEND_CACHE_FORMAT_VERSION,
    bytes: 0,
    entries: new Map(),
  };
  scope[FRONTEND_CACHE_SYMBOL] = created;
  return created;
}

function readFrontendCache(key: string): ParsedWorkflow | undefined {
  const store = frontendCacheStore();
  const entry = store.entries.get(key);
  if (!entry) return undefined;
  store.entries.delete(key);
  store.entries.set(key, entry);
  return entry.parsed;
}

function writeFrontendCache(key: string, parsed: ParsedWorkflow): void {
  const store = frontendCacheStore();
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > FRONTEND_CACHE_MAX_BYTES) return;
  deleteFrontendCache(key);
  store.entries.set(key, { parsed, bytes });
  store.bytes += bytes;
  while (store.entries.size > FRONTEND_CACHE_MAX_ENTRIES || store.bytes > FRONTEND_CACHE_MAX_BYTES) {
    const oldest = store.entries.keys().next().value as string | undefined;
    if (!oldest) break;
    deleteFrontendCache(oldest);
  }
}

function deleteFrontendCache(key: string): void {
  const store = frontendCacheStore();
  const entry = store.entries.get(key);
  if (!entry) return;
  store.entries.delete(key);
  store.bytes -= entry.bytes;
}

function invalidDefinition(
  namespace: WorkflowNamespace,
  filePath: string,
  name: string,
  error: unknown,
): InvalidWorkflowDefinitionRef {
  const sourceLocation = error instanceof WorkflowScriptError
    && typeof error.location?.line === "number"
    && typeof error.location.column === "number"
    ? { line: error.location.line, column: error.location.column }
    : undefined;
  return {
    kind: "definition",
    namespace,
    path: filePath,
    name,
    error: errorMessage(error),
    ...(sourceLocation ? { location: sourceLocation } : {}),
  };
}

function compareInvalidRefs(
  left: InvalidWorkflowDefinitionRef,
  right: InvalidWorkflowDefinitionRef,
): number {
  return left.namespace.localeCompare(right.namespace)
    || left.path.localeCompare(right.path)
    || left.name.localeCompare(right.name)
    || left.error.localeCompare(right.error);
}

function workflowBuiltinsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtins");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
