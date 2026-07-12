import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { getAgentDir, projectWorkflowDir } from "../src/persistence/paths.js";
import { includeProjectWorkflowResources } from "../src/persistence/trust.js";

let oldAgentDir: string | undefined;
let oldCodingAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  oldCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-project-trust-"));
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  if (oldCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldCodingAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("project trust integration", () => {
  it("prefers the current Pi agent-dir environment variable", () => {
    process.env.PI_AGENT_DIR = path.join(tmp, "legacy-agent");
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, "current-agent");

    expect(getAgentDir()).toBe(path.join(tmp, "current-agent"));
  });

  it("skips project workflows when the session context is not trusted", async () => {
    const cwd = path.join(tmp, "project");
    const workflows = projectWorkflowDir(cwd);
    await fs.promises.mkdir(workflows, { recursive: true });
    await fs.promises.writeFile(
      path.join(workflows, "project-only.js"),
      "export const meta = { name: 'project_only', description: 'project-local workflow' };\nreturn 'ok';\n",
      "utf8",
    );

    const registry = new WorkflowRegistry();
    await registry.refresh(cwd, { includeProject: includeProjectWorkflowResources({ isProjectTrusted: () => false }) });
    expect(registry.get("project_only")).toBeUndefined();

    await registry.refresh(cwd, { includeProject: includeProjectWorkflowResources({ isProjectTrusted: () => true }) });
    expect(registry.get("project_only")).toMatchObject({ source: "project" });
  });
});
