import { describe, expect, it } from "vitest";
import { parseWorkflowCommand } from "../src/commands/workflow-command-parser.js";

describe("parseWorkflowCommand", () => {
  it("parses empty input", () => {
    expect(parseWorkflowCommand("")).toEqual({ action: "manager" });
  });

  it("parses activation commands", () => {
    expect(parseWorkflowCommand("enable")).toEqual({ action: "enable" });
    expect(parseWorkflowCommand("on")).toEqual({ action: "enable" });
    expect(parseWorkflowCommand("disable")).toEqual({ action: "disable" });
    expect(parseWorkflowCommand("off")).toEqual({ action: "disable" });
    expect(parseWorkflowCommand("toggle")).toEqual({ action: "toggle" });
    expect(parseWorkflowCommand("status")).toEqual({ action: "status" });
  });

  it("parses run args and modes", () => {
    expect(parseWorkflowCommand("run research --args '{\"q\":\"x y\"}' --await")).toEqual({ action: "run", target: "research", args: { q: "x y" }, mode: "await" });
    expect(() => parseWorkflowCommand("run x --await --async")).toThrow(/mutually/);
  });

  it("parses aliases and open target", () => {
    expect(parseWorkflowCommand("ls --running")).toEqual({ action: "list", filter: "running" });
    expect(parseWorkflowCommand("cont wr_1")).toEqual({ action: "continue", runId: "wr_1" });
    expect(parseWorkflowCommand("rm wr_1")).toEqual({ action: "delete", runId: "wr_1" });
    expect(parseWorkflowCommand("open wr_1 ui")).toEqual({ action: "open", runId: "wr_1", target: "ui" });
    expect(parseWorkflowCommand("open wr_1 ui artifact_view")).toEqual({ action: "open", runId: "wr_1", target: "ui", viewId: "artifact_view" });
    expect(parseWorkflowCommand("open wr_1 ui --profile panel --width 140")).toEqual({ action: "open", runId: "wr_1", target: "ui", profile: "panel", width: 140 });
    expect(parseWorkflowCommand("open wr_1 ui artifact_view --profile full --width 999")).toEqual({ action: "open", runId: "wr_1", target: "ui", viewId: "artifact_view", profile: "full", width: 240 });
    expect(parseWorkflowCommand("preview-ui '{\"title\":\"Preview\"}' --profile panel --width 140")).toEqual({ action: "preview-ui", json: '{"title":"Preview"}', profile: "panel", width: 140 });
    expect(() => parseWorkflowCommand("open wr_1 result --profile panel")).toThrow(/only valid/);
  });
});
