import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/types.js";
import { isDown, isEnter, isEscape, isExit, isPageDown } from "../src/ui/simple-components.js";
import { WorkflowManagerComponent } from "../src/ui/workflow-manager.js";
import { visibleWidth } from "../src/utils/truncate.js";

describe("workflow custom input", () => {
  it("uses injected pi keybindings for manager navigation and close", () => {
    const doneValues: Array<string | undefined> = [];
    const keybindings = fakeKeybindings({
      downKey: "tui.select.down",
      enterKey: "tui.select.confirm",
      exitKey: "app.exit",
    });
    const component = new WorkflowManagerComponent([run("wr_one"), run("wr_two")], (value) => doneValues.push(value), undefined, keybindings);

    component.handleInput("downKey");
    component.handleInput("enterKey");
    component.handleInput("exitKey");

    expect(doneValues).toEqual(["wr_two", undefined]);
  });

  it("renders the selected workflow as a full-width highlighted block", () => {
    const component = new WorkflowManagerComponent([run("wr_one"), run("wr_two")], () => undefined, selectedTheme());
    const lines = component.render(80);

    expect(lines[3]).toContain("\u001b[48;5;238m");
    expect(lines[4]).toContain("\u001b[48;5;238m");
    expect(visibleWidth(lines[3])).toBe(80);
    expect(visibleWidth(lines[4])).toBe(80);
    expect(lines[3]).toContain("▸");
  });

  it("recognizes Kitty and modifyOtherKeys sequences without trapping the user", () => {
    expect(isDown("\u001b[1;1B")).toBe(true);
    expect(isPageDown("\u001b[6;1~")).toBe(true);
    expect(isEnter("\u001b[13u")).toBe(true);
    expect(isEscape("\u001b[99;5u")).toBe(true);
    expect(isEscape("\u001b[27;5;99~")).toBe(true);
    expect(isExit("\u001b[100;5u")).toBe(true);
    expect(isExit("\u001b[27;5;100~")).toBe(true);
  });
});

function fakeKeybindings(bindings: Record<string, string>) {
  return {
    matches(data: string, keybinding: string): boolean {
      return bindings[data] === keybinding;
    },
  };
}

function selectedTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => `\u001b[48;5;238m${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
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
      cached: 0,
      skipped: 0,
      calls: [],
      recentLogs: [],
      updatedAt: new Date(0).toISOString(),
    },
    usage: { agentCount: 0, subagentTokens: 0, toolUses: 0 },
    uiViews: [],
  };
}
