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
