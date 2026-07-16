import { spawn } from "node:child_process";
import * as path from "node:path";
import { readUtf8IfExists } from "../fs.ts";
import { mergeProcessEnv, resolveWorkspaceRootForPath } from "../language-environments.ts";
import type { FormatterResult, FormatterRunRecord, FormatServiceStatus } from "../types.ts";
import { listFormatterCommandStatus, selectFormatter, type SelectedFormatter } from "./formatters.ts";

export interface FormatServiceConfiguration {
  projectRoot: string;
  trustedEnvironmentRoots?: string[];
  timeoutMs?: number;
}

export interface FormatServiceOptions extends FormatServiceConfiguration {
  formatterOverrides?: Record<string, unknown>;
}

interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_FORMAT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 8_000;

export class FormatService {
  private projectRoot: string;
  private readonly formatterOverrides: Record<string, unknown>;
  private trustedEnvironmentRoots: string[];
  private timeoutMs: number;
  private recentRuns: FormatterRunRecord[] = [];

  constructor(options: FormatServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.formatterOverrides = options.formatterOverrides ?? {};
    this.trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FORMAT_TIMEOUT_MS;
  }

  configure(options: FormatServiceConfiguration): void {
    this.projectRoot = path.resolve(options.projectRoot);
    this.trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    this.timeoutMs = options.timeoutMs ?? this.timeoutMs;
  }

  async formatFile(filePath: string, beforeContent: string): Promise<FormatterResult> {
    const startedAt = Date.now();
    const resolved = path.resolve(this.projectRoot, filePath);
    const workspaceRoot = resolveWorkspaceRootForPath(resolved, this.projectRoot, this.trustedEnvironmentRoots);
    const selection = selectFormatter(resolved, workspaceRoot, this.formatterOverrides, this.trustedEnvironmentRoots);

    if (selection.kind === "none") {
      return this.record(resolved, {
        changed: false,
        finalContent: beforeContent,
        errors: [],
        skippedReason: selection.reason,
        durationMs: Date.now() - startedAt,
      });
    }

    if (selection.kind === "unavailable") {
      return this.record(resolved, {
        formatterName: selection.label,
        command: selection.command,
        changed: false,
        finalContent: beforeContent,
        errors: [],
        skippedReason: selection.reason,
        durationMs: Date.now() - startedAt,
      });
    }

    const formatter = selection.formatter;
    const run = await runFormatterProcess(formatter, workspaceRoot, this.timeoutMs);
    const finalContent = readUtf8IfExists(resolved) ?? beforeContent;
    const errors = formatterErrors(formatter, run);

    return this.record(resolved, {
      formatterName: formatter.label,
      command: formatter.command,
      changed: finalContent !== beforeContent,
      finalContent,
      errors,
      durationMs: Date.now() - startedAt,
    });
  }

  getStatus(): FormatServiceStatus {
    return {
      recentRuns: [...this.recentRuns].reverse(),
      commands: listFormatterCommandStatus(this.projectRoot, this.formatterOverrides, this.trustedEnvironmentRoots),
    };
  }

  private record(filePath: string, result: FormatterResult): FormatterResult {
    this.recentRuns.push({
      filePath,
      at: Date.now(),
      formatterName: result.formatterName,
      command: result.command,
      changed: result.changed,
      errors: result.errors,
      skippedReason: result.skippedReason,
      durationMs: result.durationMs,
    });
    if (this.recentRuns.length > 50) {
      this.recentRuns.splice(0, this.recentRuns.length - 50);
    }
    return result;
  }
}

export function createFormatService(options: FormatServiceOptions): FormatService {
  return new FormatService(options);
}

function runFormatterProcess(formatter: SelectedFormatter, cwd: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(formatter.command, formatter.args, {
      cwd,
      env: mergeProcessEnv(formatter.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 750).unref?.();
    }, Math.max(1, timeoutMs));
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: null, signal: null, stdout, stderr: appendLimited(stderr, error.message), timedOut });
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function formatterErrors(formatter: SelectedFormatter, result: SpawnResult): string[] {
  if (!result.timedOut && result.status === 0) return [];

  const lines = [`${formatter.label} failed${result.timedOut ? " (timed out)" : result.status === null ? "" : ` with exit ${result.status}`}`];
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  if (output) lines.push(output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n... truncated` : output);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  return [lines.join("\n")];
}

function appendLimited(existing: string, extra: string): string {
  const combined = existing + extra;
  return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(-MAX_OUTPUT_CHARS);
}
