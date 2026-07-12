import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/types.js";
import { PagerComponent } from "../src/ui/simple-components.js";
import { WorkflowManagerComponent } from "../src/ui/workflow-manager.js";
import { visibleWidth } from "../src/utils/truncate.js";

describe("workflow non-interactive previews", () => {
  it("does not expose input handlers that can steal Escape or Ctrl-C", () => {
    const manager = new WorkflowManagerComponent([run("wr_one")]);
    const pager = new PagerComponent("artifact", ["line"]);

    expect((manager as any).handleInput).toBeUndefined();
    expect((pager as any).handleInput).toBeUndefined();
  });

  it("renders workflow rows as full-width static preview lines", () => {
    const component = new WorkflowManagerComponent([run("wr_one"), run("wr_two")], selectedTheme());
    const lines = component.render(80);

    expect(lines[3]).toContain("1.");
    expect(lines[5]).toContain("2.");
    expect(lines.at(-1)).toContain("Non-interactive preview");
    expect(visibleWidth(lines[3])).toBe(80);
    expect(visibleWidth(lines[4])).toBe(80);
  });
});

function selectedTheme() {
  return {
    fg: (_name: string, text: string) => text,
  };
}

function run(runId: string): RunRecord {
  return {
    runId,
    taskId: `task_${runId}`,
    sessionId: "session",
    name: runId,
    description: `Run ${runId}`,
    status: "completed",
    scriptPath: "/tmp/workflow.js",
    runDir: "/tmp/run",
    journalPath: "/tmp/run/journal.jsonl",
    logsPath: "/tmp/run/logs.txt",
    manifestPath: "/tmp/run/run.json",
    argsPath: "/tmp/run/args.json",
    transcriptDir: "/tmp/run/transcripts",
    startedAt: new Date(0).toISOString(),
    argsHash: "args",
    scriptHash: "script",
    progress: {
      total: 1,
      running: 0,
      completed: 1,
      failed: 0,
      skipped: 0,
      calls: [],
      recentLogs: [],
      updatedAt: new Date(0).toISOString(),
    },
    usage: { agentCount: 0, subagentTokens: 0, toolUses: 0 },
    uiViews: [],
  };
}
