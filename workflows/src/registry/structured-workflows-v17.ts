import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowNamespace } from "../definition/types.js";
import { parseWorkflowV17 } from "../definition/workflow-v17-frontend.js";
import {
  WORKFLOW_V17_RUNTIME_API_HASH,
  WORKFLOW_V17_RUNTIME_API_VERSION,
  WORKFLOW_V17_SOURCE_EXTENSION,
} from "../definition/workflow-language-v17.js";
import type {
  ParsedWorkflowV17,
  WorkflowV17SourceLocation,
} from "../definition/workflow-v17-types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { projectWorkflowDir, userWorkflowDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { stableHash } from "../utils/hashes.js";
import {
  defaultWorkflowV17RegistryPolicy,
  readWorkflowV17RegistryPolicy,
  WorkflowV17RegistryPromotionPendingError,
  WORKFLOW_V17_REGISTRY_PROMOTION_FILE,
  workflowV17Exposure,
  type WorkflowV17Exposure,
  type WorkflowV17RegistryPolicySnapshot,
} from "./workflow-v17-policy.js";

export type WorkflowV17Id = `${WorkflowNamespace}:${string}`;

export interface WorkflowV17DefinitionRef {
  formatVersion: 1;
  id: WorkflowV17Id;
  namespace: WorkflowNamespace;
  name: string;
  title?: string;
  description: string;
  input: import("../types.js").JsonSchema;
  output: import("../types.js").JsonSchema;
  concurrency?: number;
  exposure: WorkflowV17Exposure;
  policy: WorkflowV17RegistryPolicySnapshot;
  path: string;
  source: string;
  sourceHash: string;
  definitionHash: string;
  parsed: ParsedWorkflowV17;
}

export interface InvalidWorkflowV17DefinitionRef {
  kind: "definition" | "policy";
  namespace: WorkflowNamespace;
  path: string;
  name: string;
  error: string;
  location?: WorkflowV17SourceLocation;
}

export interface WorkflowV17RegistryRefreshOptions {
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

/** Filesystem registry for reviewed v17 definitions. It is intentionally not used by v16 launch. */
export class WorkflowV17Registry {
  private refs = new Map<string, WorkflowV17DefinitionRef>();
  private invalid: InvalidWorkflowV17DefinitionRef[] = [];

  async refresh(cwd: string, options: WorkflowV17RegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, WorkflowV17DefinitionRef>();
    const invalid: InvalidWorkflowV17DefinitionRef[] = [];
    const roots: RegistryRoot[] = [
      { namespace: "builtin", directory: options.builtinDir ?? workflowV17BuiltinsDir() },
      { namespace: "user", directory: options.userDir ?? userWorkflowDir() },
    ];
    if (options.includeProject !== false) {
      roots.push({ namespace: "project", directory: options.projectDir ?? projectWorkflowDir(cwd) });
    }

    for (const root of roots) {
      const discovered = await discoverWorkflowV17Root(root, options.apiPath);
      invalid.push(...discovered.invalid);
      for (const ref of discovered.refs) refs.set(ref.id, ref);
    }
    this.refs = refs;
    this.invalid = invalid.sort(compareInvalidRefs);
  }

  list(): WorkflowV17DefinitionRef[] {
    return [...this.refs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listInvalid(): InvalidWorkflowV17DefinitionRef[] {
    return [...this.invalid];
  }

  get(id: string): WorkflowV17DefinitionRef | undefined {
    if (id.includes(":")) return this.refs.get(id);
    const matches = this.list().filter((ref) => ref.name === id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolve(id: string): WorkflowV17DefinitionRef {
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

export function workflowV17DefinitionHash(
  workflowId: WorkflowV17Id,
  parsed: ParsedWorkflowV17,
): string {
  return stableHash({
    formatVersion: 1,
    workflowId,
    sourceHash: parsed.sourceHash,
    runtimeApiVersion: WORKFLOW_V17_RUNTIME_API_VERSION,
    runtimeApiHash: WORKFLOW_V17_RUNTIME_API_HASH,
    metadata: parsed.metadata,
    descriptors: parsed.descriptors,
    review: parsed.review,
    transform: parsed.transform,
  });
}

async function discoverWorkflowV17Root(
  root: RegistryRoot,
  apiPath: string | undefined,
): Promise<{ refs: WorkflowV17DefinitionRef[]; invalid: InvalidWorkflowV17DefinitionRef[] }> {
  const directory = path.resolve(root.directory);
  let names: string[];
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Workflow registry root must be a regular non-symlink directory");
    }
    names = (await fs.promises.readdir(directory))
      .filter((name) => name.endsWith(WORKFLOW_V17_SOURCE_EXTENSION))
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
        error: `Too many ${WORKFLOW_V17_SOURCE_EXTENSION} files (${names.length}/${DEFINITION_LIMITS.filesPerNamespace})`,
      }],
    };
  }

  let policy: WorkflowV17RegistryPolicySnapshot;
  let fallbackPolicy = false;
  const invalid: InvalidWorkflowV17DefinitionRef[] = [];
  try {
    policy = await readWorkflowV17RegistryPolicy(directory, root.namespace);
  } catch (error) {
    if (error instanceof WorkflowV17RegistryPromotionPendingError) {
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
    policy = defaultWorkflowV17RegistryPolicy(directory, root.namespace);
    invalid.push({
      kind: "policy",
      namespace: root.namespace,
      path: path.join(directory, "registry.json"),
      name: "registry",
      error: errorMessage(error),
    });
  }

  const refs: WorkflowV17DefinitionRef[] = [];
  const installedNames = new Set(names.map((name) => name.slice(0, -WORKFLOW_V17_SOURCE_EXTENSION.length)));
  for (const exposed of policy.model) {
    if (!installedNames.has(exposed)) {
      invalid.push({
        kind: "policy",
        namespace: root.namespace,
        path: policy.path,
        name: exposed,
        error: `Workflow registry policy names missing definition ${exposed}${WORKFLOW_V17_SOURCE_EXTENSION}`,
      });
    }
  }

  for (const name of names) {
    const filePath = path.join(directory, name);
    const installedName = name.slice(0, -WORKFLOW_V17_SOURCE_EXTENSION.length);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Workflow definition must be a regular non-symlink file");
      }
      const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes);
      const parsed = parseWorkflowV17(source, {
        fileName: filePath,
        ...(apiPath ? { apiPath } : {}),
      });
      if (parsed.installedName !== installedName) throw new Error("Workflow frontend returned another installed name");
      const id = `${root.namespace}:${installedName}` as WorkflowV17Id;
      const ref: WorkflowV17DefinitionRef = {
        formatVersion: 1,
        id,
        namespace: root.namespace,
        name: installedName,
        ...(parsed.metadata.title ? { title: parsed.metadata.title } : {}),
        description: parsed.metadata.description,
        input: parsed.metadata.input,
        output: parsed.metadata.output,
        ...(parsed.metadata.concurrency !== undefined ? { concurrency: parsed.metadata.concurrency } : {}),
        exposure: workflowV17Exposure(policy, installedName),
        policy,
        path: filePath,
        source,
        sourceHash: parsed.sourceHash,
        definitionHash: workflowV17DefinitionHash(id, parsed),
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
        await fs.promises.lstat(path.join(directory, WORKFLOW_V17_REGISTRY_PROMOTION_FILE));
        throw new WorkflowV17RegistryPromotionPendingError(
          path.join(directory, WORKFLOW_V17_REGISTRY_PROMOTION_FILE),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { refs, invalid };
    }
    const finalPolicy = await readWorkflowV17RegistryPolicy(directory, root.namespace);
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
        path: error instanceof WorkflowV17RegistryPromotionPendingError
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
): InvalidWorkflowV17DefinitionRef {
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
  left: InvalidWorkflowV17DefinitionRef,
  right: InvalidWorkflowV17DefinitionRef,
): number {
  return left.namespace.localeCompare(right.namespace)
    || left.path.localeCompare(right.path)
    || left.name.localeCompare(right.name)
    || left.error.localeCompare(right.error);
}

function workflowV17BuiltinsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtins");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
