import { describe, expect, it } from "vitest";
import type { WorkflowLaunchOutput } from "../src/types.js";
import { renderWorkflowResultLines } from "../src/ui/workflow-result-component.js";
import { visibleWidth } from "../src/utils/truncate.js";

describe("workflow result renderer", () => {
  it("bounds live output while retaining the latest execution activity", () => {
    const details = fixture("async_launched");
    details.progress!.calls = Array.from({ length: 20 }, (_, index) => ({
      callId: String(index + 1).padStart(4, "0"),
      label: `branch ${index + 1}`,
      phase: "Review",
      status: index === 19 ? "running" : "done",
      startedAt: details.startedAt,
    }));
    details.progress!.total = 20;
    details.progress!.completed = 19;
    details.progress!.running = 1;
    details.progress!.recentLogs = ["old log", "latest log"];

    const lines = renderWorkflowResultLines(details, { partial: true }, undefined, 60);

    expect(lines.length).toBeLessThanOrEqual(16);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(lines.join("\n")).toContain("0020 branch 20");
    expect(lines.join("\n")).not.toContain("0001 branch 1");
    expect(lines.join("\n")).toContain("latest log");
    expect(lines.join("\n")).not.toContain("old log");
  });

  it("keeps the result and artifact path visible after completion", () => {
    const details = fixture("completed");
    details.resultPreview = "first\nsecond\nthird";
    details.outputPath = "/tmp/workflow/output.json";

    const rendered = renderWorkflowResultLines(details, {}, undefined, 80).join("\n");

    expect(rendered).toContain("✓ Review");
    expect(rendered).toContain("▶ Verify");
    expect(rendered).toContain("result: third");
    expect(rendered).toContain("output: /tmp/workflow/output.json");
  });
});

function fixture(status: WorkflowLaunchOutput["status"]): WorkflowLaunchOutput {
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    status,
    taskId: "task",
    runId: "run",
    name: "bounded",
    description: "bounded renderer",
    phases: [{ title: "Review" }, { title: "Verify" }],
    summary: "summary",
    scriptPath: "/tmp/script.js",
    transcriptDir: "/tmp/subagents",
    startedAt,
    endedAt: status === "completed" ? new Date().toISOString() : undefined,
    progress: {
      total: 1,
      running: 0,
      completed: 1,
      failed: 0,
      skipped: 0,
      phase: status === "completed" ? "Verify" : "Review",
      calls: [{ callId: "0001", label: "review", phase: "Review", status: "done", startedAt }],
      recentLogs: [],
      updatedAt: new Date().toISOString(),
    },
  };
}
