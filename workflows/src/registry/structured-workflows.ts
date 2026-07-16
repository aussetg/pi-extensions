import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { projectWorkflowDir, userWorkflowDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import {
  STRUCTURED_RUNTIME_API_DESCRIPTOR,
  STRUCTURED_RUNTIME_API_HASH,
  STRUCTURED_RUNTIME_API_VERSION,
  parseStructuredWorkflow,
} from "../definition/workflow-definition.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import type {
  InvalidStructuredWorkflowRef,
  StructuredWorkflowRef,
  WorkflowInvocationSnapshot,
  WorkflowNamespace,
} from "../definition/types.js";

export interface StructuredWorkflowRegistryRefreshOptions {
  includeProject?: boolean;
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
}

export class StructuredWorkflowRegistry {
  private refs = new Map<string, StructuredWorkflowRef>();
  private invalid: InvalidStructuredWorkflowRef[] = [];

  async refresh(cwd: string, options: StructuredWorkflowRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, StructuredWorkflowRef>();
    const invalid: InvalidStructuredWorkflowRef[] = [];
    const roots: Array<{ namespace: WorkflowNamespace; dir: string }> = [
      { namespace: "builtin", dir: options.builtinDir ?? structuredBuiltinsDir() },
      { namespace: "user", dir: options.userDir ?? userWorkflowDir() },
    ];
    if (options.includeProject !== false) {
      roots.push({ namespace: "project", dir: options.projectDir ?? projectWorkflowDir(cwd) });
    }

    for (const root of roots) {
      const discovered = await discoverDefinitionFiles(root.dir, root.namespace);
      const names = new Set<string>();
      for (const entry of discovered) {
        if (entry.error) {
          invalid.push(entry.error);
          continue;
        }
        const ref = entry.ref!;
        if (names.has(ref.name)) {
          invalid.push({
            namespace: root.namespace,
            path: ref.path,
            name: ref.name,
            error: `Duplicate ${root.namespace} workflow name: ${ref.name}`,
          });
          refs.delete(ref.id);
          continue;
        }
        names.add(ref.name);
        refs.set(ref.id, ref);
      }
    }

    this.refs = refs;
    this.invalid = invalid.sort(compareInvalidRefs);
  }

  list(): StructuredWorkflowRef[] {
    return [...this.refs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listInvalid(): InvalidStructuredWorkflowRef[] {
    return [...this.invalid];
  }

  get(id: string): StructuredWorkflowRef | undefined {
    if (id.includes(":")) return this.refs.get(id);
    const matches = this.list().filter((ref) => ref.name === id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolve(id: string): StructuredWorkflowRef {
    if (id.includes(":")) {
      const ref = this.refs.get(id);
      if (!ref) throw new Error(`Unknown structured workflow: ${id}`);
      return ref;
    }
    const matches = this.list().filter((ref) => ref.name === id);
    if (matches.length === 0) throw new Error(`Unknown structured workflow: ${id}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous structured workflow ${id}; use one of: ${matches.map((ref) => ref.id).join(", ")}`);
    }
    return matches[0]!;
  }

  snapshot(id: string, args: unknown): WorkflowInvocationSnapshot {
    return createWorkflowInvocationSnapshot(this.resolve(id), args);
  }
}

export function createWorkflowInvocationSnapshot(ref: StructuredWorkflowRef, args: unknown): WorkflowInvocationSnapshot {
  const input = canonicalJsonObject(args, {
    maxBytes: DEFINITION_LIMITS.invocationBytes,
    maxDepth: DEFINITION_LIMITS.invocationDepth,
    maxNodes: DEFINITION_LIMITS.invocationNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  });
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(ref.inputSchema);
  if (!validate(input)) throw new Error(`Invalid arguments for ${ref.id}: ${ajv.errorsText(validate.errors)}`);

  const definitionHash = stableHash({
    id: ref.id,
    name: ref.name,
    title: ref.title ?? null,
    description: ref.description,
    inputSchema: ref.inputSchema,
    outputSchema: ref.outputSchema,
    capabilities: ref.capabilities,
    modelVisible: ref.modelVisible,
    maxParallelism: ref.maxParallelism ?? null,
    sourceHash: ref.sourceHash,
    runtimeApiVersion: STRUCTURED_RUNTIME_API_VERSION,
    runtimeApiHash: STRUCTURED_RUNTIME_API_HASH,
    review: ref.parsed.review,
  });

  const snapshot: WorkflowInvocationSnapshot = {
    formatVersion: 1,
    workflowId: ref.id,
    namespace: ref.namespace,
    name: ref.name,
    ...(ref.title ? { title: ref.title } : {}),
    description: ref.description,
    capabilities: [...ref.capabilities],
    modelVisible: ref.modelVisible,
    ...(ref.maxParallelism !== undefined ? { maxParallelism: ref.maxParallelism } : {}),
    source: ref.source,
    sourceHash: ref.sourceHash,
    runtimeApiVersion: STRUCTURED_RUNTIME_API_VERSION,
    runtimeApiHash: STRUCTURED_RUNTIME_API_HASH,
    definitionHash,
    inputSchema: ref.inputSchema,
    outputSchema: ref.outputSchema,
    input,
    inputHash: stableHash(input),
    review: ref.parsed.review,
    installedPath: ref.path,
  };
  return deepFreezeJson(snapshot as any) as unknown as WorkflowInvocationSnapshot;
}

export async function writeWorkflowInvocationSnapshot(runDir: string, snapshot: WorkflowInvocationSnapshot): Promise<void> {
  if (snapshot.runtimeApiVersion !== STRUCTURED_RUNTIME_API_VERSION || snapshot.runtimeApiHash !== STRUCTURED_RUNTIME_API_HASH) {
    throw new Error("Workflow invocation requires a different definition-language revision");
  }
  if (sha256(snapshot.source) !== snapshot.sourceHash) throw new Error("Workflow invocation source hash is corrupt");
  const parent = path.dirname(runDir);
  await fs.promises.mkdir(parent, { recursive: true });
  try {
    await fs.promises.lstat(runDir);
    throw fileExistsError(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.${path.basename(runDir)}.snapshot-${process.pid}-${crypto.randomUUID()}`);
  await fs.promises.mkdir(temporary, { mode: 0o700 });
  const { source, ...invocation } = snapshot;
  try {
    const context = path.join(temporary, "context");
    await fs.promises.mkdir(context, { mode: 0o700 });
    await Promise.all([
      writeExclusive(path.join(temporary, "source.flow.js"), source),
      writeExclusive(path.join(context, "invocation.json"), `${stableJson(invocation)}\n`),
      writeExclusive(path.join(context, "runtime-api.json"), `${stableJson({
        version: STRUCTURED_RUNTIME_API_VERSION,
        hash: STRUCTURED_RUNTIME_API_HASH,
        descriptor: STRUCTURED_RUNTIME_API_DESCRIPTOR,
      })}\n`),
    ]);
    await fs.promises.rename(temporary, runDir);
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw fileExistsError(runDir);
    throw error;
  }
}

async function discoverDefinitionFiles(
  dir: string,
  namespace: WorkflowNamespace,
): Promise<Array<{ ref?: StructuredWorkflowRef; error?: InvalidStructuredWorkflowRef }>> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".flow.js")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ error: { namespace, path: dir, name: path.basename(dir), error: (error as Error).message } }];
  }
  if (names.length > DEFINITION_LIMITS.filesPerNamespace) {
    return [
      {
        error: {
          namespace,
          path: dir,
          name: path.basename(dir),
          error: `Too many .flow.js files (${names.length}/${DEFINITION_LIMITS.filesPerNamespace})`,
        },
      },
    ];
  }

  const result: Array<{ ref?: StructuredWorkflowRef; error?: InvalidStructuredWorkflowRef }> = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const stem = name.slice(0, -".flow.js".length);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("definition is not a regular non-symlink file");
      const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes);
      const parsed = parseStructuredWorkflow(source);
      if (parsed.metadata.name !== stem) {
        throw new Error(`definition name ${parsed.metadata.name} must match file stem ${stem}`);
      }
      const id = `${namespace}:${parsed.metadata.name}` as const;
      result.push({
        ref: Object.freeze({
          ...parsed.metadata,
          id,
          namespace,
          path: filePath,
          source,
          sourceHash: parsed.sourceHash,
          parsed,
        }),
      });
    } catch (error) {
      result.push({ error: invalidDefinition(namespace, filePath, stem, error) });
    }
  }
  return result;
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function invalidDefinition(
  namespace: WorkflowNamespace,
  filePath: string,
  name: string,
  error: unknown,
): InvalidStructuredWorkflowRef {
  const location = error instanceof WorkflowScriptError &&
    typeof error.location?.line === "number" &&
    typeof error.location.column === "number"
    ? { line: error.location.line, column: error.location.column }
    : undefined;
  return {
    namespace,
    path: filePath,
    name,
    error: error instanceof Error ? error.message : String(error),
    ...(location ? { location } : {}),
  };
}

function compareInvalidRefs(left: InvalidStructuredWorkflowRef, right: InvalidStructuredWorkflowRef): number {
  return left.namespace.localeCompare(right.namespace) || left.path.localeCompare(right.path);
}

function structuredBuiltinsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtins");
}

function fileExistsError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`Invocation snapshot already exists: ${filePath}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

