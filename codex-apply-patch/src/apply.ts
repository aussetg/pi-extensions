import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ApplyPatchOperation, ApplyPatchOpType } from "./types.ts";
import { applyCodexCreateBody, applyCodexUpdateWithRecovery } from "./apply-body.ts";
import { generateDiffFromReplacements } from "./diff-generate.ts";
import {
  MAX_DIFF_INPUT_BYTES,
  buildPierreCreatePayload,
  buildPierreDeletePayload,
  buildPierreUpdatePayload,
} from "./pierre/metadata.ts";
import type { PierreDiffPayload } from "./pierre/types.ts";
import {
  detectLineEnding,
  DiffError,
  isNotFoundError,
  normalizeLineEndings,
  restoreLineEndings,
  shortenPathForDisplay,
  stripBom,
  toFsPath,
  validatePatchPath,
} from "./util.ts";

// Atomic write using a temp file in the same directory. Best-effort mode preservation.
async function writeFileAtomic(
  abs: string,
  content: string,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );

  await fs.writeFile(tmp, content, "utf8");
  if (typeof mode === "number") {
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // ignore (best effort)
    }
  }

  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    // Windows can fail rename() if the target exists.
    try {
      await fs.unlink(abs);
      await fs.rename(tmp, abs);
    } catch {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

export async function withMutationQueues<T>(
  touchedPaths: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const uniquePaths = [...new Set(touchedPaths)].sort();
  let run = fn;

  // Acquire in stable order so multi-file patches and moves cannot deadlock
  // against another apply_patch call that touches the same files in reverse.
  for (let i = uniquePaths.length - 1; i >= 0; i--) {
    const filePath = uniquePaths[i]!;
    const next = run;
    run = () => withFileMutationQueue(filePath, next);
  }

  return run();
}

export interface ApplyOperationResult {
  type: ApplyPatchOpType;
  path: string;
  status: "completed" | "failed";
  output?: string;
  diff?: string;
  firstChangedLine?: number;
  pierre?: PierreDiffPayload;
}

export interface PreparedApplyTask {
  index: number;
  type: ApplyPatchOpType;
  rel: string;
  abs: string;
  displayPath: string;
  touchedPaths: string[];
  diff?: string;
  moveRel?: string;
  moveAbs?: string;
}

interface VirtualFileState {
  exists: boolean;
  content?: string;
  mode?: number;
  isDirectory?: boolean;
  size?: number;
}

type PlannedMutation =
  | {
      kind: "write";
      abs: string;
      content: string;
      mode?: number;
    }
  | {
      kind: "delete";
      abs: string;
    }
  | {
      kind: "move-write";
      fromAbs: string;
      toAbs: string;
      content: string;
      mode?: number;
    };

interface PlannedApplyTask {
  task: PreparedApplyTask;
  result: ApplyOperationResult;
  mutation: PlannedMutation;
  fuzz: number;
  warning?: string;
  preview?: { path?: string; diff?: string };
}

export interface PrepareApplyTasksResult {
  tasks: PreparedApplyTask[];
  presetResults: Array<ApplyOperationResult | undefined>;
}

export function prepareApplyTasks(
  operations: ApplyPatchOperation[],
  cwd: string,
): PrepareApplyTasksResult {
  const tasks: PreparedApplyTask[] = [];
  const presetResults: Array<ApplyOperationResult | undefined> = new Array(
    operations.length,
  );

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    const type = op.type;

    let rel: string;
    let abs: string;
    try {
      rel = validatePatchPath(op.path);
      abs = toFsPath(cwd, rel);
    } catch (err) {
      presetResults[i] = {
        type,
        path: typeof op.path === "string" ? op.path : "(invalid)",
        status: "failed",
        output: err instanceof Error ? err.message : String(err),
      };
      continue;
    }

    const task: PreparedApplyTask = {
      index: i,
      type,
      rel,
      abs,
      displayPath: shortenPathForDisplay(rel),
      touchedPaths: [abs],
      diff:
        typeof op.diff === "string" ? normalizeLineEndings(op.diff) : undefined,
    };

    if (
      (type === "create_file" || type === "update_file") &&
      typeof task.diff !== "string"
    ) {
      presetResults[i] = {
        type,
        path: rel,
        status: "failed",
        output: `${type} missing diff for ${rel}`,
      };
      continue;
    }

    if (
      type === "update_file" &&
      typeof op.move_path === "string" &&
      op.move_path.length > 0
    ) {
      try {
        task.moveRel = validatePatchPath(op.move_path);
        task.moveAbs = toFsPath(cwd, task.moveRel);
        if (task.moveAbs !== abs) task.touchedPaths.push(task.moveAbs);
      } catch (err) {
        presetResults[i] = {
          type,
          path: rel,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
        };
        continue;
      }
    }

    tasks.push(task);
  }

  return { tasks, presetResults };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function skippedResult(task: PreparedApplyTask, output: string): ApplyOperationResult {
  return {
    type: task.type,
    path: task.rel,
    status: "failed",
    output,
  };
}

// Preflight every operation against a virtual filesystem state before committing
// any writes. This avoids partially applying a multi-file patch when an earlier
// operation is valid but a later operation has a conflict, missing file, or path
// collision. I/O errors can still happen during commit, so commit reporting
// explicitly marks completed/failed/skipped operations.
export async function applyOperations(
  operations: ApplyPatchOperation[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (
    message: string,
    preview?: { path?: string; diff?: string },
  ) => void,
): Promise<{
  fuzz: number;
  results: ApplyOperationResult[];
  warnings: string[];
}> {
  const { tasks, presetResults } = prepareApplyTasks(operations, cwd);
  const results: Array<ApplyOperationResult | undefined> = presetResults;
  const planned: PlannedApplyTask[] = [];
  const virtualFiles = new Map<string, VirtualFileState>();

  const finalizeResults = (): ApplyOperationResult[] =>
    results.map((res, i): ApplyOperationResult => {
      if (res) return res;
      const op = operations[i]!;
      return {
        type: op.type,
        path: typeof op.path === "string" ? op.path : "(invalid)",
        status: "failed",
        output: "Internal error: missing result",
      };
    });

  const skipUnresolvedTasks = (message: string) => {
    for (const task of tasks) {
      if (!results[task.index]) results[task.index] = skippedResult(task, message);
    }
  };

  const getVirtualState = async (
    abs: string,
    needContent: boolean,
  ): Promise<VirtualFileState> => {
    const cached = virtualFiles.get(abs);
    if (cached && (!needContent || cached.content !== undefined || !cached.exists)) {
      return cached;
    }

    try {
      const st = await fs.stat(abs);
      const state: VirtualFileState = {
        exists: true,
        mode: st.mode,
        isDirectory: st.isDirectory(),
        size: st.size,
      };
      if (needContent && !state.isDirectory) {
        state.content = await fs.readFile(abs, "utf8");
      }
      virtualFiles.set(abs, state);
      return state;
    } catch (err) {
      if (isNotFoundError(err)) {
        const state: VirtualFileState = { exists: false };
        virtualFiles.set(abs, state);
        return state;
      }
      throw err;
    }
  };

  if (results.some((res) => res?.status === "failed")) {
    skipUnresolvedTasks("Skipped because preflight failed; no files were modified.");
    return { fuzz: 0, results: finalizeResults(), warnings: [] };
  }

  onProgress?.(`Preflighting ${operations.length} operation(s)...`);

  for (const task of tasks) {
    if (signal?.aborted) throw new Error("Aborted");

    const stepPreview =
      task.type === "update_file" &&
      typeof task.diff === "string" &&
      task.diff.length > 0
        ? { path: task.displayPath }
        : undefined;
    onProgress?.(
      `${task.index + 1}/${operations.length} preflight ${task.type} ${task.rel}`,
      stepPreview,
    );

    const { type, rel, abs, diff } = task;
    try {
      if (type === "create_file") {
        if (typeof diff !== "string")
          throw new DiffError(`create_file missing diff for ${rel}`);
        const state = await getVirtualState(abs, false);
        if (state.exists) throw new DiffError(`File already exists at path '${rel}'`);

        const content = applyCodexCreateBody(diff);
        planned.push({
          task,
          result: {
            type,
            path: rel,
            status: "completed",
            pierre: buildPierreCreatePayload({ path: rel, newContent: content }),
          },
          mutation: { kind: "write", abs, content },
          fuzz: 0,
        });
        virtualFiles.set(abs, {
          exists: true,
          content,
          isDirectory: false,
          size: Buffer.byteLength(content, "utf8"),
        });
        continue;
      }

      if (type === "update_file") {
        if (typeof diff !== "string")
          throw new DiffError(`update_file missing diff for ${rel}`);

        const state = await getVirtualState(abs, true);
        if (!state.exists) throw new DiffError(`File not found at path '${rel}'`);
        if (state.isDirectory) throw new DiffError(`Path is a directory: '${rel}'`);

        const rawCurrent = state.content ?? "";
        const { bom, text: current } = stripBom(rawCurrent);
        const originalEnding = detectLineEnding(current);
        const { output, fuzz, replacements, normalizedMarkers } =
          applyCodexUpdateWithRecovery(current, diff, rel);
        if (!task.moveAbs && normalizeLineEndings(current) === output) {
          throw new DiffError(`No changes made to ${rel}.`);
        }

        const generatedDiff = generateDiffFromReplacements(
          current,
          output,
          replacements,
        );
        const finalOutput = bom + restoreLineEndings(output, originalEnding);
        const buildPierre = (newPath: string) =>
          buildPierreUpdatePayload({
            oldPath: rel,
            newPath,
            oldContent: current,
            newContent: output,
          });
        const warning =
          normalizedMarkers && normalizedMarkers.length > 0
            ? `Warning: forbidden marker lines were auto-removed: ${normalizedMarkers.join(", ")}. Use only @@/space/+/- lines.`
            : undefined;

        if (task.moveAbs && task.moveRel) {
          const relTo = task.moveRel;
          const absTo = task.moveAbs;
          const targetState = await getVirtualState(absTo, false);
          if (targetState.exists)
            throw new DiffError(`Target already exists at path '${relTo}'`);

          planned.push({
            task,
            result: {
              type,
              path: relTo,
              status: "completed",
              output: `Moved from ${rel}`,
              diff: generatedDiff.diff,
              firstChangedLine: generatedDiff.firstChangedLine,
              pierre: buildPierre(relTo),
            },
            mutation: {
              kind: "move-write",
              fromAbs: abs,
              toAbs: absTo,
              content: finalOutput,
              mode: state.mode,
            },
            fuzz,
            warning,
            preview: stepPreview,
          });
          virtualFiles.set(abs, { exists: false });
          virtualFiles.set(absTo, {
            exists: true,
            content: finalOutput,
            mode: state.mode,
            isDirectory: false,
            size: Buffer.byteLength(finalOutput, "utf8"),
          });
          continue;
        }

        planned.push({
          task,
          result: {
            type,
            path: rel,
            status: "completed",
            diff: generatedDiff.diff,
            firstChangedLine: generatedDiff.firstChangedLine,
            pierre: buildPierre(rel),
          },
          mutation: { kind: "write", abs, content: finalOutput, mode: state.mode },
          fuzz,
          warning,
          preview: stepPreview,
        });
        virtualFiles.set(abs, {
          exists: true,
          content: finalOutput,
          mode: state.mode,
          isDirectory: false,
          size: Buffer.byteLength(finalOutput, "utf8"),
        });
        continue;
      }

      const state = await getVirtualState(abs, false);
      if (!state.exists) throw new DiffError(`File not found at path '${rel}'`);
      if (state.isDirectory) throw new DiffError(`Path is a directory: '${rel}'`);

      let pierre: PierreDiffPayload | undefined;
      if (state.content !== undefined || (state.size ?? 0) <= MAX_DIFF_INPUT_BYTES) {
        const contentState = await getVirtualState(abs, true);
        pierre = buildPierreDeletePayload({
          path: rel,
          oldContent: contentState.content ?? "",
        });
      }

      planned.push({
        task,
        result: { type, path: rel, status: "completed", pierre },
        mutation: { kind: "delete", abs },
        fuzz: 0,
      });
      virtualFiles.set(abs, { exists: false });
    } catch (err) {
      results[task.index] = {
        type,
        path: rel,
        status: "failed",
        output: errorMessage(err),
      };
      skipUnresolvedTasks("Skipped because preflight failed; no files were modified.");
      return { fuzz: 0, results: finalizeResults(), warnings: [] };
    }
  }

  const ensuredDirs = new Map<string, Promise<void>>();
  const ensureDir = async (dir: string) => {
    const inFlight = ensuredDirs.get(dir);
    if (inFlight) return inFlight;

    const pending = fs.mkdir(dir, { recursive: true }).catch((err) => {
      ensuredDirs.delete(dir);
      throw err;
    });
    ensuredDirs.set(dir, pending);
    return pending;
  };
  let fuzzTotal = 0;
  const warnings = new Set<string>();

  const commitFailure = (
    plannedTask: PlannedApplyTask,
    err: unknown,
    completedCount: number,
  ) => {
    const partial = completedCount > 0 ? " Partial changes may have been applied." : "";
    results[plannedTask.task.index] = {
      type: plannedTask.task.type,
      path: plannedTask.result.path,
      status: "failed",
      output: `Commit failed after ${completedCount} completed operation(s).${partial} ${errorMessage(err)}`,
    };
    for (const pending of planned) {
      if (!results[pending.task.index]) {
        results[pending.task.index] = skippedResult(
          pending.task,
          "Skipped after commit failure; earlier changes may have been applied.",
        );
      }
    }
  };

  onProgress?.(`Committing ${planned.length} operation(s)...`);

  for (let i = 0; i < planned.length; i++) {
    if (signal?.aborted) throw new Error("Aborted");

    const plannedTask = planned[i]!;
    onProgress?.(
      `${plannedTask.task.index + 1}/${operations.length} commit ${plannedTask.task.type} ${plannedTask.task.rel}`,
      plannedTask.preview,
    );

    try {
      const mutation = plannedTask.mutation;
      if (mutation.kind === "write") {
        await ensureDir(path.dirname(mutation.abs));
        await writeFileAtomic(mutation.abs, mutation.content, mutation.mode);
      } else if (mutation.kind === "delete") {
        await fs.unlink(mutation.abs);
      } else {
        await ensureDir(path.dirname(mutation.toAbs));
        await writeFileAtomic(mutation.toAbs, mutation.content, mutation.mode);
        await fs.unlink(mutation.fromAbs);
      }
    } catch (err) {
      commitFailure(plannedTask, err, i);
      return { fuzz: fuzzTotal, results: finalizeResults(), warnings: [...warnings] };
    }

    results[plannedTask.task.index] = plannedTask.result;
    fuzzTotal += plannedTask.fuzz;
    if (plannedTask.warning) warnings.add(plannedTask.warning);
  }

  return { fuzz: fuzzTotal, results: finalizeResults(), warnings: [...warnings] };
}

