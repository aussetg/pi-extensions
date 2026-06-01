import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeWorkflowCommand } from "../src/commands/workflow-command.js";
import { workflowFilePath } from "../src/persistence/paths.js";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowViewRenderer } from "../src/ui/workflow-view-renderer.js";

const meta = { name: "x", description: "test workflow" };
const source = "export const meta = { name: 'x', description: 'test workflow' };\nreturn 'ok';\n";

let oldAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-command-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("/workflow save", () => {
  it("refuses to overwrite an existing workflow file", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const target = workflowFilePath("project", cwd, record.name);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, "existing workflow", "utf8");

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "save", runId: record.runId, scope: "project" },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/already exists/);

    await expect(fs.promises.readFile(target, "utf8")).resolves.toBe("existing workflow");
  });
});
