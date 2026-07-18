import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { workflowApplyLockRoot } from "../persistence/paths.js";
import { stableHash } from "../utils/hashes.js";

const HOLDER_SOURCE = String.raw`
process.stdout.write("workflow-lock-ready\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(1));
`;

export interface WorkflowApplyLockOptions {
  lockRoot?: string;
  flockPath?: string;
  timeoutMs?: number;
}

/**
 * Serialize live-project mutation with a kernel flock held by a child whose
 * stdin is owned by this coordinator. A crash closes the pipe and releases
 * the lock; no stale lock recovery protocol is needed.
 */
export async function withWorkflowApplyLock<T>(
  projectRootInput: string,
  signal: AbortSignal,
  body: () => Promise<T>,
  options: WorkflowApplyLockOptions = {},
): Promise<T> {
  signal.throwIfAborted();
  const projectRoot = await safeProjectRoot(projectRootInput);
  const lockRoot = path.resolve(options.lockRoot ?? workflowApplyLockRoot());
  await safeLockRoot(lockRoot);
  const lockPath = path.join(lockRoot, `apply-${stableHash(projectRoot).slice(7, 39)}.lock`);
  await safeLockFile(lockPath);
  const holder = await acquire(
    options.flockPath ?? "/usr/bin/flock",
    lockPath,
    boundedTimeout(options.timeoutMs ?? 30_000),
    signal,
  );
  try {
    signal.throwIfAborted();
    return await body();
  } finally {
    await release(holder);
  }
}

async function safeProjectRoot(input: string): Promise<string> {
  const requested = path.resolve(input);
  const [stat, real] = await Promise.all([
    fs.promises.lstat(requested),
    fs.promises.realpath(requested),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== requested) {
    throw new Error("Workflow apply project root is unsafe");
  }
  return requested;
}

async function safeLockRoot(root: string): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fs.promises.lstat(root), fs.promises.realpath(root)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== root) {
    throw new Error("Workflow apply lock root is unsafe");
  }
  await fs.promises.chmod(root, 0o700);
}

async function safeLockFile(file: string): Promise<void> {
  try {
    const handle = await fs.promises.open(file, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Workflow apply lock file is unsafe");
  }
  await fs.promises.chmod(file, 0o600);
}

async function acquire(
  flockPath: string,
  lockPath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ChildProcess> {
  await fs.promises.access(flockPath, fs.constants.X_OK);
  const child = spawn(flockPath, [
    "--exclusive",
    "--timeout",
    String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
    lockPath,
    process.execPath,
    "-e",
    HOLDER_SOURCE,
  ], {
    cwd: "/",
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  let stderr = "";
  child.stdin?.on("error", () => { /* lock-holder failure is reported by child close */ });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      child.stdout!.removeListener("data", data);
      child.removeListener("error", failed);
      child.removeListener("close", closed);
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(signal.reason ?? new Error("Workflow apply lock was cancelled"));
    };
    const data = (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk}`.slice(-256);
      if (stdout.includes("workflow-lock-ready\n")) finish();
    };
    const failed = (error: Error) => finish(error);
    const closed = (code: number | null, childSignal: NodeJS.Signals | null) => finish(new Error(
      stderr.trim() || `Could not acquire workflow apply lock (${childSignal ?? code ?? "unknown"})`,
    ));
    child.stdout!.on("data", data);
    child.once("error", failed);
    child.once("close", closed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return child;
}

async function release(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin?.end();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
  timeout.unref?.();
  try { await closed; } finally { clearTimeout(timeout); }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new Error("Workflow apply lock timeout must be 1–300000 ms");
  }
  return value;
}
