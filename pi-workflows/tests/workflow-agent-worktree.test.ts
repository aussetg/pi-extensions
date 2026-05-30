import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
