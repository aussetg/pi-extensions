import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { Stats } from "node:fs";
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

let tempCounter = 0;

function nextSiblingTempPath(abs: string, tag: string): string {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  tempCounter += 1;
  return path.join(
    dir,
    `.${base}.apply-patch-${process.pid}-${Date.now()}-${tempCounter}-${Math.random().toString(16).slice(2)}.${tag}`,
  );
}

function chmodMode(mode: number | undefined): number | undefined {
  return typeof mode === "number" ? mode & 0o7777 : undefined;
}

async function unlinkIfExists(abs: string): Promise<void> {
  try {
    await fs.unlink(abs);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

async function lstatIfExists(abs: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(abs);
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }
}

async function reserveSiblingPath(abs: string, tag: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = nextSiblingTempPath(abs, tag);
    try {
      const handle = await fs.open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
    }
  }

  throw new DiffError(`Could not reserve temporary path near '${abs}'`);
}

async function writeTempSibling(
  abs: string,
  content: string,
  mode?: number,
): Promise<string> {
  const tmp = nextSiblingTempPath(abs, "tmp");
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    const nextMode = chmodMode(mode);
    if (typeof nextMode === "number") await fs.chmod(tmp, nextMode);
    return tmp;
  } catch (err) {
    await unlinkIfExists(tmp).catch(() => {});
    throw err;
  }
}

async function installCreatedFile(
  abs: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tmp = await writeTempSibling(abs, content, mode);
  try {
    // link(2) fails if `abs` already exists, so create_file cannot race into
    // overwriting a file that appeared after preflight.
    await fs.link(tmp, abs);
  } catch (err) {
    await unlinkIfExists(tmp).catch(() => {});
    throw err;
  }

  await unlinkIfExists(tmp).catch(() => {});
}

async function installReplacementFile(
  abs: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tmp = await writeTempSibling(abs, content, mode);
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await unlinkIfExists(tmp).catch(() => {});
    throw err;
  }
}

async function reflinkBackupFile(abs: string, mode?: number): Promise<string> {
  const backup = nextSiblingTempPath(abs, "backup");
  try {
    await fs.copyFile(
      abs,
      backup,
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE,
    );
  } catch {
    await unlinkIfExists(backup).catch(() => {});
    await fs.copyFile(abs, backup, fs.constants.COPYFILE_EXCL);
  }

  const nextMode = chmodMode(mode);
  if (typeof nextMode === "number") {
    await fs.chmod(backup, nextMode).catch(() => {});
  }
  return backup;
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
  isFile?: boolean;
  isDirectory?: boolean;
  isSymlink?: boolean;
  size?: number;
}

type PlannedMutation =
  | {
      kind: "write";
      abs: string;
      content: string;
      replace: boolean;
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

type JournalEntry =
  | {
      kind: "created";
      abs: string;
    }
  | {
      kind: "replaced" | "deleted";
      abs: string;
      backup: string;
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
      const st = await fs.lstat(abs);
      const state: VirtualFileState = {
        exists: true,
        mode: st.mode,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymlink: st.isSymbolicLink(),
        size: st.size,
      };
      if (needContent && state.isFile) {
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
          mutation: { kind: "write", abs, content, replace: false },
          fuzz: 0,
        });
        virtualFiles.set(abs, {
          exists: true,
          content,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
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
        if (state.isSymlink)
          throw new DiffError(`Refusing to update symlink at path '${rel}'`);
        if (!state.isFile) throw new DiffError(`Path is not a regular file: '${rel}'`);

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
            isFile: true,
            isDirectory: false,
            isSymlink: false,
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
          mutation: {
            kind: "write",
            abs,
            content: finalOutput,
            replace: true,
            mode: state.mode,
          },
          fuzz,
          warning,
          preview: stepPreview,
        });
        virtualFiles.set(abs, {
          exists: true,
          content: finalOutput,
          mode: state.mode,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
          size: Buffer.byteLength(finalOutput, "utf8"),
        });
        continue;
      }

      const state = await getVirtualState(abs, false);
      if (!state.exists) throw new DiffError(`File not found at path '${rel}'`);
      if (state.isDirectory) throw new DiffError(`Path is a directory: '${rel}'`);

      let pierre: PierreDiffPayload | undefined;
      if (
        state.isFile &&
        !state.isSymlink &&
        (state.content !== undefined || (state.size ?? 0) <= MAX_DIFF_INPUT_BYTES)
      ) {
        try {
          const contentState = await getVirtualState(abs, true);
          if (contentState.content !== undefined) {
            pierre = buildPierreDeletePayload({
              path: rel,
              oldContent: contentState.content,
            });
          }
        } catch {
          // Delete previews are best-effort. Unlink permission depends on the
          // parent directory, not on being able to read the file itself.
        }
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

  // File-level transaction journal. Replacements keep a cheap reflink backup
  // when the filesystem supports it; deletes/moves rename the old path aside so
  // unreadable files and symlinks can still be restored on failure.
  const journal: JournalEntry[] = [];
  const completedTasks: PlannedApplyTask[] = [];

  const assertAbsent = async (abs: string) => {
    const st = await lstatIfExists(abs);
    if (st) throw new DiffError(`Path appeared during commit: '${abs}'`);
  };

  const assertReplaceableFile = async (abs: string) => {
    const st = await lstatIfExists(abs);
    if (!st) throw new DiffError(`Path disappeared during commit: '${abs}'`);
    if (st.isDirectory()) throw new DiffError(`Path became a directory: '${abs}'`);
    if (st.isSymbolicLink())
      throw new DiffError(`Path became a symlink during commit: '${abs}'`);
    if (!st.isFile()) throw new DiffError(`Path is not a regular file: '${abs}'`);
    return st;
  };

  const commitMutation = async (mutation: PlannedMutation) => {
    if (mutation.kind === "write") {
      await ensureDir(path.dirname(mutation.abs));
      if (mutation.replace) {
        const st = await assertReplaceableFile(mutation.abs);
        const backup = await reflinkBackupFile(mutation.abs, st.mode);
        journal.push({ kind: "replaced", abs: mutation.abs, backup });
        await installReplacementFile(
          mutation.abs,
          mutation.content,
          mutation.mode,
        );
        return;
      }

      await assertAbsent(mutation.abs);
      await installCreatedFile(mutation.abs, mutation.content, mutation.mode);
      journal.push({ kind: "created", abs: mutation.abs });
      return;
    }

    if (mutation.kind === "delete") {
      const st = await lstatIfExists(mutation.abs);
      if (!st) throw new DiffError(`Path disappeared during commit: '${mutation.abs}'`);
      if (st.isDirectory())
        throw new DiffError(`Path became a directory: '${mutation.abs}'`);
      const backup = await reserveSiblingPath(mutation.abs, "deleted");
      try {
        await fs.rename(mutation.abs, backup);
      } catch (err) {
        await unlinkIfExists(backup).catch(() => {});
        throw err;
      }
      journal.push({ kind: "deleted", abs: mutation.abs, backup });
      return;
    }

    await ensureDir(path.dirname(mutation.toAbs));
    const source = await assertReplaceableFile(mutation.fromAbs);
    await assertAbsent(mutation.toAbs);
    await installCreatedFile(mutation.toAbs, mutation.content, mutation.mode);
    journal.push({ kind: "created", abs: mutation.toAbs });

    const backup = await reserveSiblingPath(mutation.fromAbs, "deleted");
    try {
      await fs.rename(mutation.fromAbs, backup);
    } catch (err) {
      await unlinkIfExists(backup).catch(() => {});
      throw err;
    }
    journal.push({
      kind: "deleted",
      abs: mutation.fromAbs,
      backup,
    });

    const nextMode = chmodMode(source.mode);
    if (typeof nextMode === "number") {
      await fs.chmod(backup, nextMode).catch(() => {});
    }
  };

  const cleanupJournal = async (): Promise<string[]> => {
    const cleanupWarnings: string[] = [];
    for (const entry of journal) {
      if (entry.kind === "created") continue;
      try {
        await unlinkIfExists(entry.backup);
      } catch (err) {
        cleanupWarnings.push(
          `Warning: could not remove rollback backup ${shortenPathForDisplay(entry.backup)}: ${errorMessage(err)}`,
        );
      }
    }
    return cleanupWarnings;
  };

  const rollbackJournal = async (): Promise<string[]> => {
    const rollbackErrors: string[] = [];

    for (let i = journal.length - 1; i >= 0; i--) {
      const entry = journal[i]!;
      try {
        if (entry.kind === "created") {
          await unlinkIfExists(entry.abs);
          continue;
        }

        await fs.rename(entry.backup, entry.abs);
      } catch (err) {
        rollbackErrors.push(
          `${shortenPathForDisplay(entry.abs)}: ${errorMessage(err)}`,
        );
      }
    }

    return rollbackErrors;
  };

  const commitFailure = (
    plannedTask: PlannedApplyTask,
    err: unknown,
    rollbackErrors: string[],
  ) => {
    const rolledBack = rollbackErrors.length === 0;
    const completedCount = completedTasks.length;
    const rollbackText = rolledBack
      ? " Rolled back applied changes; no files should have been modified."
      : ` Rollback failed; partial changes may remain. Rollback errors:\n${rollbackErrors.join("\n")}`;

    for (const completed of completedTasks) {
      results[completed.task.index] = {
        type: completed.task.type,
        path: completed.result.path,
        status: "failed",
        output: rolledBack
          ? "Rolled back after commit failure; no files were modified."
          : "Commit failed and rollback was incomplete; file state may be partial.",
      };
    }

    results[plannedTask.task.index] = {
      type: plannedTask.task.type,
      path: plannedTask.result.path,
      status: "failed",
      output: `Commit failed after ${completedCount} completed operation(s).${rollbackText} ${errorMessage(err)}`,
    };
    for (const pending of planned) {
      if (!results[pending.task.index]) {
        results[pending.task.index] = skippedResult(
          pending.task,
          rolledBack
            ? "Skipped after commit failure; no files were modified."
            : "Skipped after commit failure; earlier changes may have been applied.",
        );
      }
    }
  };

  onProgress?.(`Committing ${planned.length} operation(s)...`);

  for (let i = 0; i < planned.length; i++) {
    const plannedTask = planned[i]!;
    try {
      if (signal?.aborted) throw new Error("Aborted");

      onProgress?.(
        `${plannedTask.task.index + 1}/${operations.length} commit ${plannedTask.task.type} ${plannedTask.task.rel}`,
        plannedTask.preview,
      );

      await commitMutation(plannedTask.mutation);
    } catch (err) {
      const rollbackErrors = await rollbackJournal();
      commitFailure(plannedTask, err, rollbackErrors);
      return { fuzz: fuzzTotal, results: finalizeResults(), warnings: [...warnings] };
    }

    results[plannedTask.task.index] = plannedTask.result;
    completedTasks.push(plannedTask);
    fuzzTotal += plannedTask.fuzz;
    if (plannedTask.warning) warnings.add(plannedTask.warning);
  }

  for (const warning of await cleanupJournal()) warnings.add(warning);

  return { fuzz: fuzzTotal, results: finalizeResults(), warnings: [...warnings] };
}

