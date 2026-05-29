import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentOptions, JsonSchema, WorkflowUsage } from "../types.js";
import { truncateBytes } from "../utils/truncate.js";
import { ensureDir } from "../persistence/paths.js";
import { WorkflowAbortError, WorkflowSkipAgentError } from "../runtime/errors.js";

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageLike {
  role: string;
  content?: MessagePart[] | string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

export interface WorkflowAgentCall {
  callId: string;
  runId: string;
  cwd: string;
  phase?: string;
  label: string;
  prompt: string;
  options: AgentOptions;
  transcriptDir: string;
  activeTools?: string[];
  signal: AbortSignal;
  stallMs: number;
  stallRetries: number;
}

export interface WorkflowAgentResult {
  result: unknown;
  resultText: string;
  transcriptPath: string;
  resultPath: string;
  usage: WorkflowUsage;
  workspace?: AgentWorkspaceArtifacts;
}

interface AgentWorkspace {
  cwd: string;
  artifacts?: AgentWorkspaceArtifacts;
  collect(): Promise<AgentWorkspaceArtifacts | undefined>;
  cleanup(): Promise<void>;
}

interface AgentWorkspaceArtifacts {
  kind: "worktree";
  worktreeDir: string;
  statusPath?: string;
  patchPath?: string;
  error?: string;
}

export class WorkflowAgent {
  async run(call: WorkflowAgentCall): Promise<WorkflowAgentResult> {
    const callDir = path.join(call.transcriptDir, call.callId);
    await ensureDir(callDir);
    const promptPath = path.join(callDir, "prompt.txt");
    await fs.promises.writeFile(promptPath, call.prompt, "utf8");

    let lastError: unknown;
    for (let attempt = 0; attempt <= call.stallRetries; attempt++) {
      try {
        return await this.runAttempt(call, callDir, attempt);
      } catch (err) {
        if (err instanceof WorkflowSkipAgentError || err instanceof WorkflowAbortError || call.signal.aborted) throw err;
        lastError = err;
        if (!String((err as Error).message).includes("stalled") || attempt >= call.stallRetries) break;
      }
    }
    const errorPath = path.join(callDir, "error.json");
    await fs.promises.writeFile(errorPath, `${JSON.stringify({ error: String((lastError as Error)?.message ?? lastError) }, null, 2)}\n`, "utf8");
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runAttempt(call: WorkflowAgentCall, callDir: string, attempt: number): Promise<WorkflowAgentResult> {
    const messages: MessageLike[] = [];
    const stderr: string[] = [];
    const workspace = await prepareAgentWorkspace(call, callDir, attempt);
    const args = ["--mode", "json", "-p", "--no-session"];
    if (call.options.model) args.push("--model", call.options.model);
    const tools = (call.activeTools ?? []).filter((name) => name !== "workflow");
    if (tools.length > 0) args.push("--tools", tools.join(","));

    const systemPrompt = buildSubagentSystemPrompt(call);
    const tmp = await writeTempPrompt(call.callId, systemPrompt);
    args.push("--append-system-prompt", tmp.filePath);
    args.push(call.prompt);

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const invocation = getPiInvocation(args);
        const proc = spawn(invocation.command, invocation.args, { cwd: workspace.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuffer = "";
        let stalled = false;
        let timer: NodeJS.Timeout | undefined;

        const resetTimer = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            stalled = true;
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 3_000).unref?.();
          }, call.options.stallMs ?? call.stallMs);
          timer.unref?.();
        };
        resetTimer();

        const abort = () => {
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 3_000).unref?.();
          reject(call.signal.reason ?? new WorkflowAbortError());
        };
        if (call.signal.aborted) return abort();
        call.signal.addEventListener("abort", abort, { once: true });

        const processLine = (line: string) => {
          if (!line.trim()) return;
          resetTimer();
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
            messages.push(event.message as MessageLike);
          }
        };

        proc.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        });
        proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (timer) clearTimeout(timer);
          call.signal.removeEventListener("abort", abort);
          if (stdoutBuffer.trim()) processLine(stdoutBuffer);
          if (stalled) reject(new Error(`Subagent ${call.callId} stalled after ${call.stallMs}ms`));
          else resolve(code ?? 0);
        });
      });

      const workspaceArtifacts = await workspace.collect();

      const transcriptPath = path.join(callDir, attempt === 0 ? "transcript.json" : `transcript-attempt-${attempt}.json`);
      await fs.promises.writeFile(transcriptPath, `${JSON.stringify({ attempt, exitCode, stderr: stderr.join(""), messages, workspace: workspaceArtifacts }, null, 2)}\n`, "utf8");
      if (exitCode !== 0) throw new Error(`Subagent ${call.callId} exited with ${exitCode}: ${truncateBytes(stderr.join(""), 4000)}`);

      const resultText = getFinalAssistantText(messages);
      const result = call.options.schema ? parseStructuredResult(resultText, call.options.schema) : resultText;
      const usage = collectUsage(messages);
      const resultPath = path.join(callDir, "result.json");
      await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result, resultText, usage, workspace: workspaceArtifacts }, null, 2)}\n`, "utf8");
      return { result, resultText, transcriptPath, resultPath, usage, workspace: workspaceArtifacts };
    } finally {
      await fs.promises.rm(tmp.dir, { recursive: true, force: true });
      await workspace.cleanup();
    }
  }
}

function buildSubagentSystemPrompt(call: WorkflowAgentCall): string {
  const schemaText = call.options.schema
    ? `\nIf a JSON schema is provided below, return ONLY a JSON value conforming to it, with no Markdown fences.\nSchema:\n${JSON.stringify(call.options.schema, null, 2)}\n`
    : "";
  const isolationText = call.options.isolation === "worktree"
    ? "\nIsolation: you are running in a disposable git worktree. Edits are safe from sibling agents and will be captured as a patch artifact; they are not applied to the user's main working tree automatically.\n"
    : "";
  return `You are a workflow subagent.\nWorkflow: ${call.runId}\nPhase: ${call.phase ?? "(none)"}\nTask label: ${call.label}\n${isolationText}\nWork independently. Do not ask the user questions. Use tools as needed. Return only the requested result.${schemaText}`;
}

function getFinalAssistantText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      if (text.trim()) return text;
    }
  }
  return "";
}

function collectUsage(messages: MessageLike[]): WorkflowUsage {
  const usage: WorkflowUsage = { agentCount: 1, subagentTokens: 0, toolUses: 0, estimated: false };
  for (const msg of messages) {
    if (msg.role === "assistant") {
      usage.subagentTokens += msg.usage?.totalTokens ?? (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
      if (Array.isArray(msg.content)) usage.toolUses += msg.content.filter((part) => part.type === "toolCall").length;
    }
  }
  return usage;
}

function parseStructuredResult(text: string, schema: JsonSchema): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Subagent structured output was not valid JSON: ${(err as Error).message}. Output: ${truncateBytes(text, 2000)}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`Subagent structured output failed schema: ${ajv.errorsText(validate.errors)}`);
  return value;
}

async function writeTempPrompt(callId: string, text: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-"));
  const filePath = path.join(dir, `${callId}.md`);
  await fs.promises.writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function prepareAgentWorkspace(call: WorkflowAgentCall, callDir: string, attempt: number): Promise<AgentWorkspace> {
  if (call.options.isolation !== "worktree") {
    return { cwd: call.cwd, collect: async () => undefined, cleanup: async () => undefined };
  }

  const git = await getGitWorkspace(call.cwd).catch((err) => {
    throw new Error(`isolation: "worktree" requires a git worktree cwd: ${(err as Error).message}`);
  });
  const worktreeDir = path.join(callDir, attempt === 0 ? "worktree" : `worktree-attempt-${attempt}`);
  const statusPath = path.join(callDir, attempt === 0 ? "worktree-status.txt" : `worktree-status-attempt-${attempt}.txt`);
  const patchPath = path.join(callDir, attempt === 0 ? "worktree.patch" : `worktree-attempt-${attempt}.patch`);

  await fs.promises.rm(worktreeDir, { recursive: true, force: true });
  await ensureDir(path.dirname(worktreeDir));
  await gitExec(["-C", git.root, "worktree", "add", "--detach", worktreeDir, "HEAD"]);

  try {
    await mirrorDirtyState(git.root, worktreeDir);
    await gitExec(["-C", worktreeDir, "add", "-A"]);
    await gitExec([
      "-C",
      worktreeDir,
      "-c",
      "user.name=pi-workflows",
      "-c",
      "user.email=pi-workflows@local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "pi workflow isolation baseline",
    ]);
  } catch (err) {
    await removeGitWorktree(git.root, worktreeDir);
    throw err;
  }

  return {
    cwd: path.join(worktreeDir, git.prefix),
    async collect() {
      const artifacts: AgentWorkspaceArtifacts = { kind: "worktree", worktreeDir, statusPath, patchPath };
      try {
        const status = await gitExec(["-C", worktreeDir, "status", "--short"], { allowFailure: true });
        await fs.promises.writeFile(statusPath, status.stdout || status.stderr || "", "utf8");
        await gitExec(["-C", worktreeDir, "add", "-A"], { allowFailure: true });
        const diff = await gitExec(["-C", worktreeDir, "diff", "--cached", "--binary", "HEAD"], { allowFailure: true, maxBuffer: 100 * 1024 * 1024 });
        if (diff.stdout.trim()) await fs.promises.writeFile(patchPath, diff.stdout, "utf8");
        else delete artifacts.patchPath;
      } catch (err) {
        artifacts.error = (err as Error).message;
      }
      return artifacts;
    },
    async cleanup() {
      await removeGitWorktree(git.root, worktreeDir);
    },
  };
}

async function getGitWorkspace(cwd: string): Promise<{ root: string; prefix: string }> {
  const root = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
  const prefix = (await gitExec(["-C", cwd, "rev-parse", "--show-prefix"])).stdout.trim();
  if (!root) throw new Error("git root not found");
  return { root, prefix };
}

async function mirrorDirtyState(root: string, worktreeDir: string): Promise<void> {
  const diff = await gitExec(["-C", root, "diff", "--binary", "HEAD"], { maxBuffer: 100 * 1024 * 1024 });
  if (diff.stdout.trim()) await gitExecInput(["-C", worktreeDir, "apply", "--whitespace=nowarn", "--binary", "-"], diff.stdout);

  const untracked = await gitExec(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 });
  const files = untracked.stdoutBuffer.toString("utf8").split("\0").filter(Boolean);
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) continue;
    const src = path.join(root, relative);
    const dst = path.join(worktreeDir, relative);
    await ensureDir(path.dirname(dst));
    await fs.promises.cp(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
  }
}

async function removeGitWorktree(root: string, worktreeDir: string): Promise<void> {
  await gitExec(["-C", root, "worktree", "remove", "--force", worktreeDir], { allowFailure: true });
  await fs.promises.rm(worktreeDir, { recursive: true, force: true });
  await gitExec(["-C", root, "worktree", "prune"], { allowFailure: true });
}

async function gitExec(args: string[], options: { allowFailure?: boolean; maxBuffer?: number; encoding?: "utf8" | "buffer" } = {}): Promise<{ stdout: string; stderr: string; stdoutBuffer: Buffer }> {
  const encoding = options.encoding ?? "utf8";
  return await new Promise((resolve, reject) => {
    execFile("git", args, { encoding: encoding as BufferEncoding, maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, env: gitEnv() }, (err, stdout, stderr) => {
      const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
      const result = { stdout: stdoutBuffer.toString("utf8"), stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""), stdoutBuffer };
      if (err && !options.allowFailure) reject(new Error(`${["git", ...args].join(" ")} failed: ${result.stderr || (err as Error).message}`));
      else resolve(result);
    });
  });
}

async function gitExecInput(args: string[], input: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("git", args, { stdio: ["pipe", "ignore", "pipe"], env: gitEnv() });
    const stderr: string[] = [];
    proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${["git", ...args].join(" ")} failed: ${stderr.join("")}`));
    });
    proc.stdin.end(input);
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}
