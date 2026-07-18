import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowNamespace } from "../definition/types.js";
import { parseWorkflow } from "../definition/workflow-frontend.js";
import {
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_RUNTIME_API_VERSION,
  WORKFLOW_SOURCE_EXTENSION,
} from "../definition/workflow-language.js";
import type {
  ParsedWorkflow,
  WorkflowSourceLocation,
} from "../definition/workflow-types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { projectWorkflowDir, userWorkflowDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { stableHash } from "../utils/hashes.js";
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
  formatVersion: 1;
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

    for (const root of roots) {
      const discovered = await discoverWorkflowRoot(root, options.apiPath);
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
      if (!ref) throw new Error(`Unknown workflow v17 definition: ${id}`);
      return ref;
    }
    const matches = this.list().filter((ref) => ref.name === id);
    if (matches.length === 0) throw new Error(`Unknown workflow v17 definition: ${id}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous workflow v17 definition ${id}; use one of: ${matches.map((ref) => ref.id).join(", ")}`);
    }
    return matches[0]!;
  }
}

export function workflowDefinitionHash(
  workflowId: WorkflowId,
  parsed: ParsedWorkflow,
): string {
  return stableHash({
    formatVersion: 1,
    workflowId,
    sourceHash: parsed.sourceHash,
    runtimeApiVersion: WORKFLOW_RUNTIME_API_VERSION,
    runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
    metadata: parsed.metadata,
    descriptors: parsed.descriptors,
    review: parsed.review,
    transform: parsed.transform,
  });
}

async function discoverWorkflowRoot(
  root: RegistryRoot,
  apiPath: string | undefined,
): Promise<{ refs: WorkflowDefinitionRef[]; invalid: InvalidWorkflowDefinitionRef[] }> {
  const directory = path.resolve(root.directory);
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { refs: [], invalid: [] };
    return {
      refs: [],
      invalid: [{
        kind: "definition",
        namespace: root.namespace,
        path: directory,
        name: path.basename(directory),
        error: errorMessage(error),
      }],
    };
  }
  if (names.length > DEFINITION_LIMITS.filesPerNamespace) {
    return {
      refs: [],
      invalid: [{
        kind: "definition",
        namespace: root.namespace,
        path: directory,
        name: path.basename(directory),
        error: `Too many ${WORKFLOW_SOURCE_EXTENSION} files (${names.length}/${DEFINITION_LIMITS.filesPerNamespace})`,
      }],
    };
  }

  let policy: WorkflowRegistryPolicySnapshot;
  let fallbackPolicy = false;
  const invalid: InvalidWorkflowDefinitionRef[] = [];
  try {
    policy = await readWorkflowRegistryPolicy(directory, root.namespace);
  } catch (error) {
    if (error instanceof WorkflowRegistryPromotionPendingError) {
      return {
        refs: [],
        invalid: [{
          kind: "policy",
          namespace: root.namespace,
          path: error.transactionPath,
          name: "registry",
          error: error.message,
        }],
      };
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

  const refs: WorkflowDefinitionRef[] = [];
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
      const parsed = parseWorkflow(source, {
        fileName: filePath,
        ...(apiPath ? { apiPath } : {}),
      });
      if (parsed.installedName !== installedName) throw new Error("Workflow frontend returned another installed name");
      const id = `${root.namespace}:${installedName}` as WorkflowId;
      const ref: WorkflowDefinitionRef = {
        formatVersion: 1,
        id,
        namespace: root.namespace,
        name: installedName,
        ...(parsed.metadata.title ? { title: parsed.metadata.title } : {}),
        description: parsed.metadata.description,
        input: parsed.metadata.input,
        output: parsed.metadata.output,
        ...(parsed.metadata.concurrency !== undefined ? { concurrency: parsed.metadata.concurrency } : {}),
        exposure: workflowExposure(policy, installedName),
        policy,
        path: filePath,
        source,
        sourceHash: parsed.sourceHash,
        definitionHash: workflowDefinitionHash(id, parsed),
        parsed,
      };
      refs.push(Object.freeze(ref));
    } catch (error) {
      invalid.push(invalidDefinition(root.namespace, filePath, installedName, error));
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
