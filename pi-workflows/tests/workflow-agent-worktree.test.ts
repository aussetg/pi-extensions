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

describe("WorkflowAgent worktree isolation", () => {
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
      options: { isolation: "shared" },
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

  it("passes inherited non-workflow tools to subagents", async () => {
    const argv = await runFakeAgentAndReadArgv("tools", ["workflow", "read", "bash", "read", "bad,tool", " "]);

    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
    expect(argv).not.toContain("--no-tools");
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
      options: { isolation: "shared" },
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
      options: { isolation: "shared" },
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
      options: { isolation: "shared" },
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
      `console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'x'.repeat(${WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes + 1}), usage: { input: 1, output: 1 } } }));`,
      "utf8",
    );
    process.argv[1] = fakePi;

    await expect(new WorkflowAgent().run({
      callId: "0001",
      runId: "wr_test",
      cwd: repo,
      label: "result limit",
      prompt: "overflow result",
      options: { isolation: "shared" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    })).rejects.toThrow(/final result exceeded/);
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
      options: { isolation: "worktree" },
      transcriptDir,
      signal: new AbortController().signal,
      stallMs: 10_000,
      stallRetries: 0,
    });

    expect(result.result).toBe("done");
    expect(await exists(path.join(repo, "agent-output.txt"))).toBe(false);
    expect(result.workspace?.kind).toBe("worktree");
    expect(result.workspace?.patchPath).toBeTruthy();
    expect(await exists(result.workspace!.worktreeDir)).toBe(false);
    const patch = await fs.promises.readFile(result.workspace!.patchPath!, "utf8");
    expect(patch).toContain("agent-output.txt");
    expect(patch).toContain("from isolated agent");
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
      options: { isolation: "worktree" },
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
    options: { isolation: "shared", ...options },
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
