import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKFLOW_RESOURCE_LIMITS } from "../src/constants.js";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";

const exec = promisify(execFile);

let tmp: string;
let oldArgv1: string | undefined;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-agent-"));
  oldArgv1 = process.argv[1];
});

afterEach(async () => {
  if (oldArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = oldArgv1;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("WorkflowAgent workspace modes", () => {
  it("collects token, tool, and model telemetry from pi JSON events", async () => {
    const repo = path.join(tmp, "repo-usage");
    const fakePi = path.join(tmp, "fake-pi-usage.mjs");
    const transcriptDir = path.join(tmp, "transcripts-usage");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        "console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} }));",
        "console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: {} }));",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'opus-test', content: [{ type: 'toolCall', id: 'fallback-only', name: 'read', arguments: {} }, { type: 'text', text: 'done' }], usage: { input: 100, output: 23 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "usage",
      prompt: "report usage",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("done");
    expect(result.model).toBe("opus-test");
    expect(result.usage).toEqual({ agentCount: 1, subagentTokens: 123, toolUses: 2, estimated: false });
    const persisted = JSON.parse(await fs.promises.readFile(result.resultPath, "utf8"));
    expect(persisted.model).toBe("opus-test");
    expect(persisted.usage.toolUses).toBe(2);
  });

  it("persists structured results with execution metadata", async () => {
    const runDir = path.join(tmp, "run-structured-result");
    const repo = path.join(tmp, "repo-structured-result");
    const fakePi = path.join(tmp, "fake-pi-structured-result.mjs");
    const transcriptDir = path.join(runDir, "subagents");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'test-model', content: '{\\\"ok\\\":true}', usage: { input: 3, output: 4 } } }));",
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "structured result",
      prompt: "emit structured result",
      options: { workspace: "shared", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }, thinking: "high" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });
    const persisted = JSON.parse(await fs.promises.readFile(result.resultPath, "utf8"));
    expect(result.result).toEqual({ ok: true });
    expect(persisted).toEqual(expect.objectContaining({
      result: { ok: true },
      status: "done",
      usage: { agentCount: 1, subagentTokens: 7, toolUses: 0, estimated: false },
      model: "test-model",
      thinking: "high",
    }));
  });

  it("decodes Pi JSON stdout across split UTF-8 chunks", async () => {
    const repo = path.join(tmp, "repo-split-utf8");
    const fakePi = path.join(tmp, "fake-pi-split-utf8.mjs");
    const transcriptDir = path.join(tmp, "transcripts-split-utf8");
    const resultText = "chunked 🙂 utf8";

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        `const resultText = ${JSON.stringify(resultText)};`,
        "const line = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: resultText, usage: { input: 1, output: 1 } } }) + '\\n';",
        "const bytes = Buffer.from(line, 'utf8');",
        "const marker = Buffer.from('🙂', 'utf8');",
        "const split = bytes.indexOf(marker) + 1;",
        "process.stdout.write(bytes.subarray(0, split));",
        "await new Promise((resolve) => setTimeout(resolve, 30));",
        "process.stdout.write(bytes.subarray(split));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "split utf8",
      prompt: "emit split utf8",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe(resultText);
    expect(result.usage).toEqual({ agentCount: 1, subagentTokens: 2, toolUses: 0, estimated: false });
  });

  it("passes inherited non-workflow tools to subagents", async () => {
    const argv = await runFakeAgentAndReadArgv("tools", ["workflow", "read", "bash", "read", "bad,tool", " "]);

    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
    expect(argv).not.toContain("--no-tools");
  });

  it("restricts read-only agents to an explicit safe tool allowlist", async () => {
    const argv = await runFakeAgentAndReadArgv("read-only-tools", ["workflow", "read", "bash", "edit", "grep", "web_fetch", "lsp"], { workspace: "readOnly" });

    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,web_fetch");
  });

  it("passes first-class thinking level to subagents", async () => {
    const argv = await runFakeAgentAndReadArgv("thinking", ["read"], { thinking: "high" });

    expect(argv).toContain("--thinking");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
  });

  it("uses a dedicated child Pi session instead of no-session mode", async () => {
    const argv = await runFakeAgentAndReadArgv("session", ["read"]);

    expect(argv).toContain("--session-dir");
    expect(argv[argv.indexOf("--session-dir") + 1]).toContain(path.join("transcripts-session", "0001", "pi-session"));
    expect(argv).not.toContain("--no-session");
  });

  it("disables subagent tools when the inherited allowlist is empty after removing workflow", async () => {
    const workflowOnlyArgv = await runFakeAgentAndReadArgv("workflow-only-tools", ["workflow"]);
    const unknownArgv = await runFakeAgentAndReadArgv("unknown-tools", undefined);

    for (const argv of [workflowOnlyArgv, unknownArgv]) {
      expect(argv).toContain("--no-tools");
      expect(argv).not.toContain("--tools");
    }
  });

  it("rejects oversized subagent stdout before persisting transcripts", async () => {
    const repo = path.join(tmp, "repo-stdout-limit");
    const fakePi = path.join(tmp, "fake-pi-stdout-limit.mjs");
    const transcriptDir = path.join(tmp, "transcripts-stdout-limit");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(fakePi, `process.stdout.write("x".repeat(${WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes + 1}));`, "utf8");
    process.argv[1] = fakePi;

    await expect(new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "stdout limit",
      prompt: "overflow stdout",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    })).rejects.toThrow(/stdout line exceeded/);
  });

  it("streams large Pi JSON output without retaining a transcript copy", async () => {
    const repo = path.join(tmp, "repo-large-stream");
    const fakePi = path.join(tmp, "fake-pi-large-stream.mjs");
    const transcriptDir = path.join(tmp, "transcripts-large-stream");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const sessionDir = process.argv[process.argv.indexOf('--session-dir') + 1];",
        "const sessionPath = path.join(sessionDir, 'nested', 'fake-session.jsonl');",
        "await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });",
        "await fs.promises.writeFile(sessionPath, JSON.stringify({ type: 'session', version: 3, id: 'fake-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: process.cwd() }) + '\\n', 'utf8');",
        "console.log(JSON.stringify({ type: 'session', version: 3, id: 'fake-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: process.cwd() }));",
        "const payload = 'x'.repeat(2048);",
        "for (let i = 0; i < 2300; i++) console.log(JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: payload }] }, assistantMessageEvent: { type: 'text_delta', delta: payload } }));",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'sonnet-test', content: [{ type: 'text', text: 'final ok' }], usage: { input: 5, output: 7 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "large stream",
      prompt: "emit noisy JSON stream",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("final ok");
    expect(result.model).toBe("sonnet-test");
    expect(result.usage).toEqual({ agentCount: 1, subagentTokens: 12, toolUses: 0, estimated: false });
    expect(result.sessionPath).toBe(path.join(transcriptDir, "0001", "pi-session", "nested", "fake-session.jsonl"));

    const transcript = JSON.parse(await fs.promises.readFile(result.transcriptPath, "utf8"));
    expect(transcript.messages).toBeUndefined();
    expect(transcript.stream.messagesRetained).toBe(false);
    expect(transcript.stream.stdoutBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(transcript.stream.messageCount).toBe(1);
    expect(transcript.stream.assistantMessageCount).toBe(1);
    expect(transcript.piSession.sessionId).toBe("fake-session");
    expect(transcript.piSession.sessionPath).toBe(result.sessionPath);
  });

  it("drops oversized aggregate events after the final message", async () => {
    const repo = path.join(tmp, "repo-aggregate-event");
    const fakePi = path.join(tmp, "fake-pi-aggregate-event.mjs");
    const transcriptDir = path.join(tmp, "transcripts-aggregate-event");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
        `process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'tool', content: 'x'.repeat(${WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes + 1}) }] }) + '\\n');`,
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "aggregate event",
      prompt: "emit aggregate event",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("done");
    const transcript = JSON.parse(await fs.promises.readFile(result.transcriptPath, "utf8"));
    expect(transcript.stream.droppedOversizeLines).toBe(1);
  });

  it("rejects oversized final subagent results", async () => {
    const repo = path.join(tmp, "repo-result-limit");
    const fakePi = path.join(tmp, "fake-pi-result-limit.mjs");
    const transcriptDir = path.join(tmp, "transcripts-result-limit");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'x'.repeat(${WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes + 1}), usage: { input: 1, output: 1 } } }) + '\\n');`,
        "await new Promise((resolve) => setTimeout(resolve, 5_000));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const run = new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "result limit",
      prompt: "overflow result",
      options: { workspace: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    await expect(rejectionMessageWithin(run, 1000)).resolves.toMatch(/final result exceeded/);
    expect(await exists(path.join(transcriptDir, "0001", "result.json"))).toBe(false);
  });

  it("reports the effective per-agent stall timeout", async () => {
    const repo = path.join(tmp, "repo-stall-timeout");
    const fakePi = path.join(tmp, "fake-pi-stall-timeout.mjs");
    const transcriptDir = path.join(tmp, "transcripts-stall-timeout");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(fakePi, "setInterval(() => {}, 1000);", "utf8");
    process.argv[1] = fakePi;

    const run = new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "stall timeout",
      prompt: "stall",
      options: { workspace: "shared", stallMs: 50 },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    await expect(rejectionMessageWithin(run, 1000)).resolves.toMatch(/stalled after 50ms/);
    const error = JSON.parse(await fs.promises.readFile(path.join(transcriptDir, "0001", "error.json"), "utf8"));
    expect(error.error).toMatch(/stalled after 50ms/);
  });

  it("does not retry a stalled shared agent after partial edits", async () => {
    const repo = path.join(tmp, "repo-shared-stall");
    const fakePi = path.join(tmp, "fake-pi-shared-stall.mjs");
    const transcriptDir = path.join(tmp, "transcripts-shared-stall");

    await fs.promises.mkdir(repo, { recursive: true });
    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.appendFile(path.join(process.cwd(), 'partial.txt'), 'edit\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const run = new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "shared stall",
      prompt: "edit then stall",
      options: { workspace: "shared", stallMs: 50 },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 5,
    });

    await expect(rejectionMessageWithin(run, 1000)).resolves.toMatch(/stalled after 50ms/);
    await expect(fs.promises.readFile(path.join(repo, "partial.txt"), "utf8")).resolves.toBe("edit\n");
    expect(await exists(path.join(transcriptDir, "0001", "pi-session-attempt-1"))).toBe(false);
  });

  it("runs the subagent in a disposable git worktree and captures edits as a patch", async () => {
    const repo = path.join(tmp, "repo");
    const fakePi = path.join(tmp, "fake-pi.mjs");
    const transcriptDir = path.join(tmp, "transcripts");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.writeFile(path.join(process.cwd(), 'agent-output.txt'), 'from isolated agent\\n');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "isolated",
      prompt: "write a file",
      options: { workspace: "patch" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("done");
    expect(await exists(path.join(repo, "agent-output.txt"))).toBe(false);
    expect(result.workspace?.kind).toBe("patch");
    expect(result.workspace?.changedFiles).toContain("agent-output.txt");
    expect(result.workspace?.patchPath).toBeTruthy();
    expect(await exists(result.workspace!.worktreeDir)).toBe(false);
    const patch = await fs.promises.readFile(result.workspace!.patchPath!, "utf8");
    expect(patch).toContain("agent-output.txt");
    expect(patch).toContain("from isolated agent");
  });

  it("cleans up worktrees after child process failures", async () => {
    const repo = path.join(tmp, "repo-child-failure");
    const fakePi = path.join(tmp, "fake-pi-child-failure.mjs");
    const transcriptDir = path.join(tmp, "transcripts-child-failure");
    const worktreeDir = path.join(transcriptDir, "0001", "worktree");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.writeFile(path.join(process.cwd(), 'failed-output.txt'), 'not kept in main repo\\n');",
        "process.stderr.write('boom\\n');",
        "process.exit(2);",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    await expect(new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "child failure",
      prompt: "fail",
      options: { workspace: "patch" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    })).rejects.toThrow(/exited with 2: boom/);

    expect(await exists(worktreeDir)).toBe(false);
    expect(await exists(path.join(repo, "failed-output.txt"))).toBe(false);
    const error = JSON.parse(await fs.promises.readFile(path.join(transcriptDir, "0001", "error.json"), "utf8"));
    expect(error.error).toMatch(/exited with 2: boom/);
  });

  it("uses attempt-scoped worktree artifact names after a stalled retry", async () => {
    const repo = path.join(tmp, "repo-retry-artifacts");
    const fakePi = path.join(tmp, "fake-pi-retry-artifacts.mjs");
    const counterPath = path.join(tmp, "retry-count.txt");
    const transcriptDir = path.join(tmp, "transcripts-retry-artifacts");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, ".gitignore"), "build/\n", "utf8");
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", ".gitignore", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        `const counterPath = ${JSON.stringify(counterPath)};`,
        "let attempt = 0; try { attempt = Number(await fs.promises.readFile(counterPath, 'utf8')); } catch {}",
        "attempt += 1; await fs.promises.writeFile(counterPath, String(attempt), 'utf8');",
        "if (attempt === 1) setInterval(() => {}, 1000);",
        "await fs.promises.writeFile(path.join(process.cwd(), 'retry-output.txt'), 'from retry\\n');",
        "await fs.promises.mkdir(path.join(process.cwd(), 'build'), { recursive: true });",
        "await fs.promises.writeFile(path.join(process.cwd(), 'build', 'ignored-retry.txt'), 'ignored retry\\n');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done after retry', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "retry artifacts",
      prompt: "stall then retry",
      options: { workspace: "patch", stallMs: 50 },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 1,
    });

    expect(result.result).toBe("done after retry");
    expect(path.basename(result.transcriptPath)).toBe("transcript-attempt-1.json");
    expect(path.basename(result.workspace!.worktreeDir)).toBe("worktree-attempt-1");
    expect(path.basename(result.workspace!.statusPath!)).toBe("worktree-status-attempt-1.txt");
    expect(path.basename(result.workspace!.patchPath!)).toBe("worktree-attempt-1.patch");
    expect(path.basename(result.workspace!.ignoredManifestPath!)).toBe("worktree-ignored-attempt-1.json");
    expect(path.basename(result.workspace!.ignoredFilesDir!)).toBe("worktree-ignored-attempt-1");
    await expect(fs.promises.readFile(path.join(result.workspace!.ignoredFilesDir!, "build", "ignored-retry.txt"), "utf8")).resolves.toBe("ignored retry\n");
  });

  it("does not mask a successful worktree result when cleanup fails", async () => {
    const repo = path.join(tmp, "repo-cleanup-failure");
    const fakePi = path.join(tmp, "fake-pi-cleanup-failure.mjs");
    const transcriptDir = path.join(tmp, "transcripts-cleanup-failure");
    const worktreeDir = path.join(transcriptDir, "0001", "worktree");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      "utf8",
    );
    process.argv[1] = fakePi;

    const realRm = fs.promises.rm;
    let worktreeRmCalls = 0;
    fs.promises.rm = (async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (path.resolve(String(target)) === path.resolve(worktreeDir) && ++worktreeRmCalls > 1) throw new Error("injected cleanup failure");
      return await realRm.call(fs.promises, target, options);
    }) as typeof fs.promises.rm;

    let result;
    try {
      result = await new WorkflowAgent().run({
        callId: "0001",
        runId: "wr_test",
        cwd: repo,
        label: "cleanup failure",
        prompt: "succeed then fail cleanup",
        options: { workspace: "patch" },
        transcriptDir,
        signal: new AbortController().signal,
        stallMs: 10_000,
        stallRetries: 0,
      });
    } finally {
      fs.promises.rm = realRm;
    }

    expect(result.result).toBe("done");
    expect(result.workspace?.error).toMatch(/worktree cleanup failed: injected cleanup failure/);
    const persisted = JSON.parse(await fs.promises.readFile(result.resultPath, "utf8"));
    expect(persisted.workspace.error).toMatch(/worktree cleanup failed: injected cleanup failure/);
    const transcript = JSON.parse(await fs.promises.readFile(result.transcriptPath, "utf8"));
    expect(transcript.workspace.error).toMatch(/worktree cleanup failed: injected cleanup failure/);
  });

  it("captures ignored worktree outputs as bounded artifacts", async () => {
    const repo = path.join(tmp, "repo-ignored");
    const fakePi = path.join(tmp, "fake-pi-ignored.mjs");
    const transcriptDir = path.join(tmp, "transcripts-ignored");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, ".gitignore"), "build/\n", "utf8");
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", ".gitignore", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.mkdir(path.join(process.cwd(), 'build'), { recursive: true });",
        "await fs.promises.writeFile(path.join(process.cwd(), 'build', 'ignored.txt'), 'ignored output\\n');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "ignored",
      prompt: "write ignored output",
      options: { workspace: "patch" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("done");
    expect(await exists(path.join(repo, "build", "ignored.txt"))).toBe(false);
    expect(result.workspace?.ignoredManifestPath).toBeTruthy();
    expect(result.workspace?.ignoredFilesDir).toBeTruthy();

    const manifest = JSON.parse(await fs.promises.readFile(result.workspace!.ignoredManifestPath!, "utf8"));
    expect(manifest.files).toEqual([expect.objectContaining({ path: "build/ignored.txt", type: "file", artifactPath: "build/ignored.txt" })]);
    expect(manifest.omitted).toEqual([]);
    await expect(fs.promises.readFile(path.join(result.workspace!.ignoredFilesDir!, "build", "ignored.txt"), "utf8")).resolves.toBe("ignored output\n");
    await expect(fs.promises.readFile(result.workspace!.statusPath!, "utf8")).resolves.toContain("!! build/ignored.txt");
  });

  it("records ignored symlinks and omits oversized ignored files", async () => {
    const repo = path.join(tmp, "repo-ignored-limits");
    const fakePi = path.join(tmp, "fake-pi-ignored-limits.mjs");
    const transcriptDir = path.join(tmp, "transcripts-ignored-limits");

    await fs.promises.mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await fs.promises.writeFile(path.join(repo, ".gitignore"), "build/\n", "utf8");
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", repo, "add", ".gitignore", "tracked.txt"]);
    await exec("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.mkdir(path.join(process.cwd(), 'build'), { recursive: true });",
        "await fs.promises.writeFile(path.join(process.cwd(), 'build', 'small.txt'), 'small\\n');",
        `await fs.promises.writeFile(path.join(process.cwd(), 'build', 'too-large.bin'), 'x'.repeat(${WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes + 1}));`,
        "await fs.promises.symlink('../tracked.txt', path.join(process.cwd(), 'build', 'tracked-link'));",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "ignored limits",
      prompt: "write ignored limits",
      options: { workspace: "patch" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    const manifest = JSON.parse(await fs.promises.readFile(result.workspace!.ignoredManifestPath!, "utf8"));
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "build/small.txt", type: "file", bytes: 6, artifactPath: "build/small.txt" }),
      expect.objectContaining({ path: "build/tracked-link", type: "symlink", target: "../tracked.txt" }),
    ]));
    expect(manifest.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ path: "build/too-large.bin", reason: "file size limit", bytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes + 1 })]));
    await expect(fs.promises.readFile(path.join(result.workspace!.ignoredFilesDir!, "build", "small.txt"), "utf8")).resolves.toBe("small\n");
    await expect(fs.promises.stat(path.join(result.workspace!.ignoredFilesDir!, "build", "too-large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.lstat(path.join(result.workspace!.ignoredFilesDir!, "build", "tracked-link"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function runFakeAgentAndReadArgv(name: string, activeTools: string[] | undefined, options: Record<string, unknown> = {}): Promise<string[]> {
  const repo = path.join(tmp, `repo-${name}`);
  const fakePi = path.join(tmp, `fake-pi-${name}.mjs`);
  const argvPath = path.join(tmp, `argv-${name}.json`);
  const transcriptDir = path.join(tmp, `transcripts-${name}`);

  await fs.promises.mkdir(repo, { recursive: true });
  await fs.promises.writeFile(
    fakePi,
    [
      "import fs from 'node:fs';",
      `await fs.promises.writeFile(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
    ].join("\n"),
    "utf8",
  );
  process.argv[1] = fakePi;

  await new WorkflowAgent().run({
    callId: "0001",
    runId: "wr_test",
    cwd: repo,
    label: name,
    prompt: "report argv",
    options: { workspace: "shared", ...options },
    transcriptDir,
    activeTools,
    signal: new AbortController().signal,
    stallMs: 10_000,
    stallRetries: 0,
  });

  return JSON.parse(await fs.promises.readFile(argvPath, "utf8")) as string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function rejectionMessageWithin(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => {
          throw new Error("expected promise to reject");
        },
        (err) => String((err as Error)?.message ?? err),
      ),
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`promise did not reject within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
