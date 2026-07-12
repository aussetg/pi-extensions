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

  it("rejects unknown, duplicate, and trailing command arguments", () => {
    expect(() => parseWorkflowCommand("list --runing")).toThrow(/Unknown list option/);
    expect(() => parseWorkflowCommand("list all")).toThrow(/Unexpected argument/);
    expect(() => parseWorkflowCommand("run x --aync")).toThrow(/Unknown workflow option/);
    expect(() => parseWorkflowCommand("run x extra")).toThrow(/Unexpected argument/);
    expect(() => parseWorkflowCommand("run x --args '{}' --args '{}'")).toThrow(/Duplicate --args/);
    expect(() => parseWorkflowCommand("run x --await --await")).toThrow(/Duplicate --await/);
    expect(() => parseWorkflowCommand("save wr_1 --scope project --scope user")).toThrow(/Duplicate --scope/);
    expect(() => parseWorkflowCommand("save wr_1 --force")).toThrow(/Unknown save option/);
    expect(() => parseWorkflowCommand("resume wr_1 --script a.js --script b.js")).toThrow(/Duplicate --script/);
    expect(() => parseWorkflowCommand("delete wr_1 extra")).toThrow(/Usage/);
    expect(() => parseWorkflowCommand("skip-agent wr_1 0001 extra")).toThrow(/Usage/);
    expect(() => parseWorkflowCommand("open wr_1 ui --profile panel --profile full")).toThrow(/Duplicate --profile/);
    expect(() => parseWorkflowCommand("preview-ui '{}' --width 80 --width 100")).toThrow(/Duplicate --width/);
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

  it("does not expose dead retry-agent control", () => {
    expect(() => parseWorkflowCommand("retry-agent wr_1 0001")).toThrow(/Unknown/);
  });
});
