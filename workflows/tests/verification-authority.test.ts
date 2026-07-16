import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentCallProvenance } from "../src/agents/call-identity.js";
import type {
  AgentExecutorDescriptor,
  AgentToolDescriptor,
} from "../src/agents/executor.js";
import {
  AgentProfileRegistry,
  snapshotAgentProfile,
} from "../src/agents/profiles.js";
import type { PreparedWorkflowExecutionResources } from "../src/agents/resources.js";
import { AgentRouteRegistry } from "../src/agents/routes.js";
import { resolveAgentTools } from "../src/agents/tool-policy.js";
import type { HostCommandExecutorDescriptor } from "../src/commands/executor.js";
import type { VerificationRecord } from "../src/runtime/durable-types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { CurrentVerificationAuthority } from "../src/verification/current-authority.js";
import { verificationGateEnvironmentHash } from "../src/verification/environment.js";
import {
  VerificationProfileRegistry,
  type VerificationProfileDefinition,
} from "../src/verification/profiles.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("current verification authority", () => {
  it("recomputes profiles, command protocol, reviewer policy, route, and tool schemas", async () => {
    const root = await fs.promises.mkdtemp(path.join(process.cwd(), ".verification-authority-"));
    roots.push(root);
    const project = path.join(root, "project");
    const verificationDir = path.join(root, "verifications");
    const agentDir = path.join(root, "agents");
    const routeFile = path.join(root, "routes.json");
    await Promise.all([
      fs.promises.mkdir(project, { recursive: true }),
      fs.promises.mkdir(verificationDir, { recursive: true }),
      fs.promises.mkdir(agentDir, { recursive: true }),
    ]);
    await writeVerificationProfile(verificationDir, verificationProfile("Current verification policy"));
    await writeAgentProfile(agentDir, "Review the exact supplied candidate.");
    await writeRoutes(routeFile, "test/reviewer-v1");

    const commandDescriptor: { current: HostCommandExecutorDescriptor } = {
      current: { id: "command-v1", protocolVersion: 1, sandbox: "fake" },
    };
    const agentDescriptor: { current: AgentExecutorDescriptor } = {
      current: executorDescriptor("read-v1"),
    };
    const resources = await preparedResources({
      project,
      verificationDir,
      agentDir,
      routeFile,
      commandDescriptor: commandDescriptor.current,
      agentDescriptor: agentDescriptor.current,
    });
    const verificationProfileSnapshot = resources.verifications[0]!;
    const selection = resources.agentSelections[0]!;
    const route = resources.routes[0]!;
    const expectedGateEnvironmentHash = verificationGateEnvironmentHash(
      verificationProfileSnapshot,
      commandDescriptor.current,
      {
        profileId: selection.profileId,
        routeId: route.id,
        authorityHash: selection.authorityHash,
      },
    );
    const verification = {
      profileId: verificationProfileSnapshot.id,
      profileHash: verificationProfileSnapshot.hash,
      gateEnvironmentHash: expectedGateEnvironmentHash,
    } as VerificationRecord;
    const authority = new CurrentVerificationAuthority({
      projectCwd: project,
      resources,
      commandExecutor: { describe: () => structuredClone(commandDescriptor.current) },
      agentExecutor: { describe: () => structuredClone(agentDescriptor.current) },
      verificationRegistry: { userDir: verificationDir, builtins: [] },
      agentProfileRegistry: { userDir: agentDir, builtins: [] },
      routeRegistry: { filePath: routeFile },
    });

    await expect(authority.binding(verification)).resolves.toEqual({
      profileHash: verification.profileHash,
      gateEnvironmentHash: verification.gateEnvironmentHash,
    });

    commandDescriptor.current = { id: "command-v2", protocolVersion: 1, sandbox: "fake" };
    expect((await authority.binding(verification)).gateEnvironmentHash).not.toBe(verification.gateEnvironmentHash);
    commandDescriptor.current = { id: "command-v1", protocolVersion: 1, sandbox: "fake" };

    await writeAgentProfile(agentDir, "Use the revised current review policy.");
    expect((await authority.binding(verification)).gateEnvironmentHash).not.toBe(verification.gateEnvironmentHash);
    await writeAgentProfile(agentDir, "Review the exact supplied candidate.");

    await writeRoutes(routeFile, "test/reviewer-v2");
    expect((await authority.binding(verification)).gateEnvironmentHash).not.toBe(verification.gateEnvironmentHash);
    await writeRoutes(routeFile, "test/reviewer-v1");

    agentDescriptor.current = executorDescriptor("read-v2");
    expect((await authority.binding(verification)).gateEnvironmentHash).not.toBe(verification.gateEnvironmentHash);
    agentDescriptor.current = executorDescriptor("read-v1");

    await writeVerificationProfile(verificationDir, verificationProfile("Changed verification policy"));
    await expect(authority.binding(verification)).rejects.toThrow(/profile.*changed/i);
  });
});

async function preparedResources(options: {
  project: string;
  verificationDir: string;
  agentDir: string;
  routeFile: string;
  commandDescriptor: HostCommandExecutorDescriptor;
  agentDescriptor: AgentExecutorDescriptor;
}): Promise<PreparedWorkflowExecutionResources> {
  const verifications = new VerificationProfileRegistry();
  await verifications.refresh(options.project, { userDir: options.verificationDir, builtins: [] });
  const verification = verifications.resolve("user:policy");
  const profiles = new AgentProfileRegistry();
  await profiles.refresh(options.project, { userDir: options.agentDir, builtins: [] });
  const profile = snapshotAgentProfile(profiles.resolve("user:reviewer"));
  const routes = new AgentRouteRegistry();
  await routes.refresh({ filePath: options.routeFile });
  const route = routes.resolve(profile.id);
  const tools = resolveAgentTools(profile, { workspace: "snapshot", network: "none" }, options.agentDescriptor);
  const authorityHash = stableHash({
    ...agentCallProvenance(profile, route, tools),
    workspace: "snapshot",
    network: "none",
    resultMode: "value",
  });
  const body: Omit<PreparedWorkflowExecutionResources, "hash"> = {
    formatVersion: 1,
    definitionSourceHash: sha256("definition"),
    projectRoot: options.project,
    projectCwd: options.project,
    profiles: [profile],
    profileSelectors: { "user:reviewer": profile.id },
    routes: [route],
    routeSnapshotHash: stableHash([route]),
    agentSelections: [{
      operationId: "verification-policy",
      profileId: profile.id,
      profileHash: profile.hash,
      routeId: route.id,
      routeHash: route.hash,
      workspace: "snapshot",
      network: "none",
      resultMode: "value",
      tools,
      authorityHash,
    }],
    contextBundle: { entries: [], hash: stableHash([]) },
    executor: options.agentDescriptor,
    commandExecutor: options.commandDescriptor,
    commands: [],
    measurements: [],
    verifications: [verification],
    candidateCapable: true,
  };
  return { ...body, hash: stableHash(body) };
}

function verificationProfile(description: string): VerificationProfileDefinition {
  return {
    name: "policy",
    description,
    tests: [{ id: "tests", argv: ["/usr/bin/true"], timeoutMs: 30_000 }],
    diagnostics: { notApplicable: "No diagnostics gate" },
    diffInspection: {
      requireChanges: true,
      maximumChangedPaths: 32,
      maximumFileBytes: 1024 * 1024,
      forbidSecrets: true,
      paths: "all-semantic-project-paths",
    },
    adversarialReview: { profile: "user:reviewer" },
  };
}

async function writeVerificationProfile(directory: string, profile: VerificationProfileDefinition): Promise<void> {
  await fs.promises.writeFile(path.join(directory, "policy.json"), `${JSON.stringify(profile)}\n`);
}

async function writeAgentProfile(directory: string, instructions: string): Promise<void> {
  await fs.promises.writeFile(path.join(directory, "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Current reviewer",
    "tools: [read]",
    "---",
    instructions,
    "",
  ].join("\n"));
}

async function writeRoutes(filePath: string, model: string): Promise<void> {
  await fs.promises.writeFile(filePath, `${JSON.stringify({
    formatVersion: 1,
    routes: { "user:reviewer": { model, thinking: "low" } },
  })}\n`);
}

function executorDescriptor(readSchema: string): AgentExecutorDescriptor {
  const tool: AgentToolDescriptor = {
    name: "read",
    schemaHash: sha256(readSchema),
    mutatesWorkspace: false,
    usesMediatedNetwork: false,
  };
  return {
    id: "agent-v1",
    protocolVersion: 1,
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog: [tool],
  };
}
