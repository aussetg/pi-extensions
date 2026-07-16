import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedStructuredWorkflow } from "../src/definition/types.js";
import type { AgentExecutorDescriptor, AgentToolDescriptor } from "../src/agents/executor.js";
import {
  AgentProfileRegistry,
  type AgentProfileDefinition,
} from "../src/agents/profiles.js";
import {
  AgentRouteRegistry,
  parseAgentRouteFile,
} from "../src/agents/routes.js";
import {
  prepareWorkflowExecutionResources,
  validatePinnedExecutionPolicy,
  type PersistedWorkflowExecutionResources,
} from "../src/agents/resources.js";
import { FIXED_AGENT_TOOL_SETS } from "../src/agents/tool-policy.js";
import { buildAgentCallKey } from "../src/agents/call-identity.js";
import { SdkAgentWorkerExecutor } from "../src/agents/sdk-executor.js";
import { stableHash } from "../src/utils/hashes.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

describe("local agent route registry", () => {
  it("uses explicit override > local file > host default precedence", async () => {
    const root = await temporary("agent-routes-");
    const filePath = path.join(root, "routes.json");
    await fs.promises.writeFile(filePath, JSON.stringify({
      formatVersion: 1,
      routes: {
        "builtin:base": { model: "local/base", thinking: "medium" },
        "builtin:researcher": { model: "local/research", thinking: "high" },
      },
    }));
    const registry = new AgentRouteRegistry();
    await registry.refresh({
      filePath,
      defaults: {
        "builtin:base": { model: "default/base", thinking: "low" },
        "builtin:reviewer": { model: "default/reviewer", thinking: "low" },
      },
      overrides: {
        "builtin:base": { model: "override/base", thinking: "xhigh" },
      },
    });

    expect(registry.resolve("builtin:base")).toMatchObject({ model: "override/base", thinking: "xhigh" });
    expect(registry.source("builtin:base")).toBe("override");
    expect(registry.resolve("builtin:researcher")).toMatchObject({ model: "local/research", thinking: "high" });
    expect(registry.source("builtin:researcher")).toBe("local");
    expect(registry.resolve("builtin:reviewer")).toMatchObject({ model: "default/reviewer", thinking: "low" });
    expect(registry.source("builtin:reviewer")).toBe("default");
  });

  it("rejects missing routes and unavailable models before run launch", () => {
    const registry = new AgentRouteRegistry({
      local: { "builtin:base": { model: "provider/missing", thinking: "low" } },
    });
    expect(() => registry.resolve("builtin:reviewer")).toThrow(/missing model route/i);
    expect(() => registry.snapshot(["builtin:base"], ["provider/available"]))
      .toThrow(/provider\/missing.*unavailable/i);
  });

  it("parses a strict credential-free local format", () => {
    expect(parseAgentRouteFile(JSON.stringify({
      formatVersion: 1,
      routes: { "builtin:base": { model: "provider/model", thinking: "max" } },
    }))).toEqual({
      formatVersion: 1,
      routes: { "builtin:base": { model: "provider/model", thinking: "max" } },
    });
    expect(() => parseAgentRouteFile(JSON.stringify({
      formatVersion: 1,
      routes: { "builtin:base": { model: "provider/model", thinking: "low", apiKey: "secret" } },
    }))).toThrow(/unknown field apiKey/i);
  });
});

describe("run launch route and tool snapshots", () => {
  it("fails launch validation for unregistered profiles and missing profile routes", async () => {
    const project = await temporary("route-validation-project-");
    const profiles = await profilesFor(project, [{
      name: "base", description: "Inspection", instructions: "Inspect.", tools: ["read"],
    }]);
    const common = {
      cwd: project,
      profileRegistry: profiles,
      availableModels: ["provider/model"],
      executorDescriptor: executorDescriptor(),
      projectGuidance: [],
    };
    await expect(prepareWorkflowExecutionResources(
      workflow([selection("work", "builtin:unknown", "snapshot", "none")]),
      { ...common, routeRegistry: new AgentRouteRegistry() },
    )).rejects.toThrow(/unknown agent profile/i);
    await expect(prepareWorkflowExecutionResources(
      workflow([selection("work", "builtin:base", "snapshot", "none")]),
      { ...common, routeRegistry: new AgentRouteRegistry() },
    )).rejects.toThrow(/missing model route.*builtin:base/i);
  });

  it("snapshots exact routes into call authority without changing workflow source", async () => {
    const project = await temporary("route-snapshot-project-");
    const parsed = workflow([selection("work", "builtin:base", "snapshot", "none")]);
    const profiles = await profilesFor(project, [{
      name: "base",
      description: "Inspection role",
      instructions: "Inspect exact evidence.",
      tools: ["read"],
    }]);
    const firstRegistry = new AgentRouteRegistry({
      local: { "builtin:base": { model: "provider/first", thinking: "low" } },
    });
    const first = await prepareWorkflowExecutionResources(parsed, {
      cwd: project,
      profileRegistry: profiles,
      routeRegistry: firstRegistry,
      availableModels: ["provider/first"],
      executorDescriptor: executorDescriptor(),
      projectGuidance: [],
    });
    const secondRegistry = new AgentRouteRegistry({
      local: { "builtin:base": { model: "provider/second", thinking: "high" } },
    });
    const second = await prepareWorkflowExecutionResources(parsed, {
      cwd: project,
      profileRegistry: profiles,
      routeRegistry: secondRegistry,
      availableModels: ["provider/second"],
      executorDescriptor: executorDescriptor(),
      projectGuidance: [],
    });

    expect(first.definitionSourceHash).toBe(second.definitionSourceHash);
    expect(first.routes[0]).toMatchObject({ profileId: "builtin:base", model: "provider/first", thinking: "low" });
    expect(first.routes[0]?.id).not.toBe(second.routes[0]?.id);
    expect(first.routeSnapshotHash).not.toBe(second.routeSnapshotHash);
    expect(first.agentSelections[0]?.routeId).toBe(first.routes[0]?.id);
    expect(first.agentSelections[0]?.authorityHash).not.toBe(second.agentSelections[0]?.authorityHash);
    const callInput = {
      previousJournalKey: stableHash("journal"),
      operationIdentity: "run/agent:work",
      semanticInputHash: stableHash("prompt"),
      finishSchemaHash: stableHash("finish-schema"),
      inputArtifactDigests: [stableHash("artifact")],
      network: "none" as const,
      preWorkspaceHash: stableHash("workspace"),
    };
    expect(buildAgentCallKey({
      ...callInput,
      profile: first.profiles[0]!,
      route: first.routes[0]!,
      tools: first.agentSelections[0]!.tools,
    })).not.toBe(buildAgentCallKey({
      ...callInput,
      profile: second.profiles[0]!,
      route: second.routes[0]!,
      tools: second.agentSelections[0]!.tools,
    }));
  });

  it("permits candidate editing and mediated research in the same agent", async () => {
    const project = await temporary("candidate-research-project-");
    const parsed = workflow(
      [selection("edit-and-research", "builtin:networked-coder", "candidate", "research")],
      ["read-project", "candidate-write", "mediated-network"],
    );
    const profiles = await profilesFor(project, [{
      name: "networked-coder",
      description: "Candidate implementation with source research",
      instructions: "Edit only the candidate and use mediated sources when needed.",
      tools: [...Object.values(FIXED_AGENT_TOOL_SETS).flat()],
    }]);
    const routes = new AgentRouteRegistry({
      local: { "builtin:networked-coder": { model: "provider/coder", thinking: "high" } },
    });
    const resources = await prepareWorkflowExecutionResources(parsed, {
      cwd: project,
      profileRegistry: profiles,
      routeRegistry: routes,
      availableModels: ["provider/coder"],
      executorDescriptor: executorDescriptor(),
      projectGuidance: [],
    });

    const selected = resources.agentSelections[0]!;
    expect(selected.workspace).toBe("candidate");
    expect(selected.network).toBe("research");
    expect(selected.tools.map((tool) => tool.name)).toEqual([
      "read", "grep", "find", "ls", "edit", "write", "delete_file",
      "web_search", "web_fetch", "workspace_command",
    ]);
    expect(selected.tools.find((tool) => tool.name === "workspace_command")).toMatchObject({
      mutatesWorkspace: true,
      usesMediatedNetwork: false,
    });
  });

  it("does not bind credential contents or re-resolve local routes on reopen", async () => {
    const project = await temporary("route-reopen-project-");
    const parsed = workflow([selection("work", "builtin:base", "snapshot", "none")]);
    const profiles = await profilesFor(project, [{
      name: "base", description: "Inspection", instructions: "Inspect.", tools: ["read"],
    }]);
    const registry = new AgentRouteRegistry({
      local: { "builtin:base": { model: "provider/model", thinking: "medium" } },
    });
    const resources = await prepareWorkflowExecutionResources(parsed, {
      cwd: project,
      profileRegistry: profiles,
      routeRegistry: registry,
      availableModels: ["provider/model"],
      executorDescriptor: executorDescriptor(),
      projectGuidance: [],
    });
    const serialized = JSON.stringify(resources);
    expect(serialized).not.toMatch(/credential|apiKey|auth\.json|token/i);
    expect(() => validatePinnedExecutionPolicy(
      resources as unknown as PersistedWorkflowExecutionResources,
      { allowedModels: ["provider/model"], allowedThinking: ["medium"] },
    )).not.toThrow();
  });

  it("keeps the executor descriptor stable across credential refreshes", async () => {
    const agentDir = await temporary("route-auth-refresh-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await fs.promises.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ token: "first" }));
      const first = new SdkAgentWorkerExecutor({ agentDir }).describe();
      await fs.promises.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ token: "refreshed" }));
      await fs.promises.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ models: ["new"] }));
      const refreshed = new SdkAgentWorkerExecutor({ agentDir }).describe();
      expect(refreshed).toEqual(first);
      expect(JSON.stringify(refreshed)).not.toMatch(/auth|credential|token/i);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

function workflow(
  agentSelections: ParsedStructuredWorkflow["agentSelections"],
  capabilities: ParsedStructuredWorkflow["metadata"]["capabilities"] = ["read-project"],
): ParsedStructuredWorkflow {
  const source = "export default defineWorkflow({ /* stable source */ });";
  return {
    metadata: {
      name: "route-fixture",
      description: "route fixture",
      inputSchema: { type: "object" },
      outputSchema: {},
      capabilities,
      modelVisible: false,
    },
    source,
    sourceHash: stableHash(source),
    executableSource: source,
    runFlowParameter: "flow",
    runArgsParameter: "args",
    topLevelConstantInitializers: [],
    operationLocations: agentSelections.map((entry) => ({ method: "agent", id: entry.id, ...entry.location })),
    agentSelections,
    commandSelections: [],
    measurementSelections: [],
    verificationSelections: [],
    review: {
      capabilities,
      agentProfiles: [...new Set(agentSelections.map((entry) => entry.profile))],
      commandProfiles: [],
      measurementProfiles: [],
      verificationProfiles: [],
      usesCandidateWrites: capabilities.includes("candidate-write"),
      usesMediatedNetwork: capabilities.includes("mediated-network"),
      humanCheckpointCount: 0,
      applySiteCount: 0,
    },
  };
}

function selection(
  id: string,
  profile: string,
  workspace: "snapshot" | "candidate",
  network: "none" | "research",
): ParsedStructuredWorkflow["agentSelections"][number] {
  return { id, profile, workspace, network, resultMode: "value", location: { line: 1, column: 1 } };
}

async function profilesFor(
  project: string,
  builtins: readonly AgentProfileDefinition[],
): Promise<AgentProfileRegistry> {
  const registry = new AgentProfileRegistry();
  await registry.refresh(project, { builtins, userDir: path.join(project, "missing-profiles") });
  return registry;
}

function executorDescriptor(): AgentExecutorDescriptor {
  const descriptors: Record<string, Omit<AgentToolDescriptor, "name" | "schemaHash">> = {
    read: { mutatesWorkspace: false, usesMediatedNetwork: false },
    grep: { mutatesWorkspace: false, usesMediatedNetwork: false },
    find: { mutatesWorkspace: false, usesMediatedNetwork: false },
    ls: { mutatesWorkspace: false, usesMediatedNetwork: false },
    edit: { mutatesWorkspace: true, usesMediatedNetwork: false },
    write: { mutatesWorkspace: true, usesMediatedNetwork: false },
    delete_file: { mutatesWorkspace: true, usesMediatedNetwork: false },
    workspace_command: { mutatesWorkspace: true, usesMediatedNetwork: false },
    web_search: { mutatesWorkspace: false, usesMediatedNetwork: true },
    web_fetch: { mutatesWorkspace: false, usesMediatedNetwork: true },
  };
  return {
    id: "test-executor",
    protocolVersion: 1,
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog: Object.entries(descriptors).map(([name, authority], index) => ({
      name,
      schemaHash: index.toString(16).padStart(64, "0"),
      ...authority,
    })),
  };
}

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
