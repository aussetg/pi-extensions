import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileRegistry,
  parseAgentProfile,
  snapshotAgentProfile,
} from "../src/agents/profiles.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

describe("semantic agent profiles", () => {
  it("keeps role instructions and fixed tool policy but rejects economic routing", () => {
    const profile = parseAgentProfile(`---
name: audit
description: Audits a package
tools: [read, grep, web_search]
---
Inspect only supplied evidence.
`);
    expect(profile).toEqual({
      name: "audit",
      description: "Audits a package",
      tools: ["read", "grep", "web_search"],
      instructions: "Inspect only supplied evidence.",
    });

    for (const field of ["model", "thinking", "temperature", "provider"]) {
      expect(() => parseAgentProfile(`---\nname: audit\ndescription: no\n${field}: value\n---\nDo work.\n`))
        .toThrow(new RegExp(`unknown.*${field}`, "i"));
    }
    expect(() => parseAgentProfile(`---
name: audit
description: no
tools: [read, bash]
---
Do work.
`)).toThrow(/fixed host tool sets/i);
  });

  it("snapshots omitted tools as the fixed inspection set", async () => {
    const project = await temporary("profiles-project-");
    const registry = new AgentProfileRegistry();
    await registry.refresh(project, {
      builtins: [{
        name: "quiet",
        description: "Read-only role",
        instructions: "Inspect the launch snapshot.",
      }],
      userDir: path.join(project, "missing"),
    });
    const snapshot = snapshotAgentProfile(registry.resolve("builtin:quiet"));
    expect(snapshot.allowedTools).toEqual(["read", "grep", "find", "ls"]);
    expect(snapshot).not.toHaveProperty("model");
    expect(snapshot).not.toHaveProperty("thinking");
  });

  it("keeps namespaces distinct and requires qualification when a short name is ambiguous", async () => {
    const root = await temporary("profiles-project-");
    const user = await temporary("profiles-user-");
    const project = path.join(root, ".pi", "agents");
    await fs.promises.mkdir(project, { recursive: true });
    const source = (description: string) =>
      `---\nname: audit\ndescription: ${description}\ntools: [read]\n---\nInspect evidence.\n`;
    await fs.promises.writeFile(path.join(user, "audit.md"), source("User audit"));
    await fs.promises.writeFile(path.join(project, "audit.md"), source("Project audit"));
    const registry = new AgentProfileRegistry();
    await registry.refresh(root, { userDir: user, projectDir: project, includeProject: true });
    expect(registry.resolve("user:audit").description).toBe("User audit");
    expect(registry.resolve("project:audit").description).toBe("Project audit");
    expect(() => registry.resolve("audit")).toThrow(/ambiguous/i);
  });
});

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
