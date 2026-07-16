import fs from "node:fs";
import path from "node:path";
import type { ParsedStructuredWorkflow } from "../definition/types.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { projectRoot } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { stableHash } from "../utils/hashes.js";
import { SandboxedCommandExecutor, type HostCommandExecutorDescriptor } from "../commands/executor.js";
import {
  assertCommandEffectAllowed,
  CommandProfileRegistry,
  type CommandProfileSnapshot,
} from "../commands/profiles.js";
import {
  MeasurementProfileRegistry,
  type MeasurementProfileSnapshot,
} from "../measurements/profiles.js";
import {
  assertMeasurementEnvironmentDescriptor,
  HostMeasurementEnvironmentProvider,
  type MeasurementEnvironmentDescriptor,
} from "../measurements/environment.js";
import {
  VerificationProfileRegistry,
  type VerificationProfileSnapshot,
} from "../verification/profiles.js";
import type { ProjectSnapshotManifest } from "../workspaces/project-snapshot.js";
import {
  assertAgentExecutorDescriptor,
  type AgentContextBundle,
  type AgentContextEntry,
  type AgentExecutorDescriptor,
  type AgentProfileSnapshot,
  type AgentRouteSnapshot,
  type AgentThinkingLevel,
  type AgentToolDescriptor,
} from "./executor.js";
import {
  AgentProfileRegistry,
  snapshotAgentProfile,
  type AgentProfileRef,
} from "./profiles.js";
import {
  AgentRouteRegistry,
  type AgentRouteMap,
} from "./routes.js";
import { resolveAgentTools } from "./tool-policy.js";
import { agentCallProvenance } from "./call-identity.js";

/** Host policy may deny a route, but credentials are deliberately not persisted or rechecked. */
export interface WorkflowExecutionPolicy {
  allowedModels?: string[];
  allowedThinking?: AgentThinkingLevel[];
}

export interface TrustedProjectGuidance {
  id?: string;
  path: string;
  text: string;
}

export interface PrepareWorkflowExecutionResourcesOptions {
  cwd: string;
  profileRegistry?: AgentProfileRegistry;
  routeRegistry?: AgentRouteRegistry;
  /** Lowest-precedence host routes used when no machine-local exact mapping exists. */
  routeDefaults?: AgentRouteMap;
  /** Highest-precedence route policy. Workflow source and invocation cannot populate this. */
  routeOverrides?: AgentRouteMap;
  routeFile?: string;
  commandProfileRegistry?: CommandProfileRegistry;
  measurementProfileRegistry?: MeasurementProfileRegistry;
  verificationProfileRegistry?: VerificationProfileRegistry;
  /** Enable only after the host has established project trust. Defaults to false. */
  includeProjectProfiles?: boolean;
  includeProjectCommands?: boolean;
  includeProjectMeasurements?: boolean;
  includeProjectVerifications?: boolean;
  /** Exact models available at launch. This validates admission but is not hashed. */
  availableModels?: readonly string[];
  policy?: WorkflowExecutionPolicy;
  executorDescriptor?: AgentExecutorDescriptor;
  commandExecutorDescriptor?: HostCommandExecutorDescriptor;
  measurementEnvironmentDescriptor?: MeasurementEnvironmentDescriptor;
  projectGuidance?: readonly TrustedProjectGuidance[];
}

export interface ResolvedAgentSelection {
  operationId: string;
  profileId: string;
  profileHash: string;
  routeId: string;
  routeHash: string;
  workspace: "snapshot" | "candidate";
  network: "none" | "research";
  resultMode: "value" | "artifact" | "value-and-artifact";
  tools: AgentToolDescriptor[];
  /** Included directly in the eventual semantic call key. */
  authorityHash: string;
}

export interface PreparedWorkflowExecutionResources {
  formatVersion: 1;
  definitionSourceHash: string;
  projectRoot: string;
  projectCwd: string;
  profiles: AgentProfileSnapshot[];
  profileSelectors: Record<string, string>;
  routes: AgentRouteSnapshot[];
  routeSnapshotHash: string;
  agentSelections: ResolvedAgentSelection[];
  contextBundle: AgentContextBundle;
  executor?: AgentExecutorDescriptor;
  commandExecutor?: HostCommandExecutorDescriptor;
  commands: CommandProfileSnapshot[];
  measurements: MeasurementProfileSnapshot[];
  verifications: VerificationProfileSnapshot[];
  measurementEnvironment?: MeasurementEnvironmentDescriptor;
  candidateCapable: boolean;
  hash: string;
}

export interface WorkflowResourceCaptureMetrics {
  projectSnapshotMs: number;
  projectSnapshotBytes: number;
  workspaceArtifactBytes: number;
}

export interface PersistedWorkflowExecutionResources extends Omit<PreparedWorkflowExecutionResources, "projectCwd"> {
  projectCwd: string;
  capture: WorkflowResourceCaptureMetrics;
  projectSnapshot: {
    root: "context/project";
    manifestPath: "context/project-manifest.json";
    manifest: ProjectSnapshotManifest;
  };
  /** Filled by the later candidate-workspace phase. */
  candidateBase?: unknown;
}

/**
 * Resolve every semantic profile, economic route, and exact tool schema before
 * any run directory, agent, command, or other effect is started.
 */
export async function prepareWorkflowExecutionResources(
  parsed: ParsedStructuredWorkflow,
  options: PrepareWorkflowExecutionResourcesOptions,
): Promise<PreparedWorkflowExecutionResources> {
  const cwd = await fs.promises.realpath(options.cwd);
  const root = await fs.promises.realpath(projectRoot(cwd));
  assertInside(root, cwd);

  const profileRegistry = options.profileRegistry ?? new AgentProfileRegistry();
  if (!options.profileRegistry) {
    await profileRegistry.refresh(cwd, { includeProject: options.includeProjectProfiles === true });
  }
  const invalidProfile = profileRegistry.listInvalid()[0];
  if (invalidProfile) throw new Error(`Invalid agent profile ${invalidProfile.path}: ${invalidProfile.error}`);

  const hasCommands = parsed.operationLocations.some((operation) => operation.method === "command");
  const hasMeasurements = parsed.operationLocations.some((operation) => operation.method === "measure");
  const hasVerifications = parsed.operationLocations.some((operation) => operation.method === "verify");
  const commandExecutor = hasCommands || hasMeasurements || hasVerifications
    ? options.commandExecutorDescriptor ?? new SandboxedCommandExecutor().describe()
    : undefined;
  assertCommandExecutor(commandExecutor);

  const commandRegistry = options.commandProfileRegistry ?? new CommandProfileRegistry();
  if (hasCommands && !options.commandProfileRegistry) {
    await commandRegistry.refresh(cwd, {
      includeProject: options.includeProjectCommands ?? options.includeProjectProfiles === true,
    });
  }
  const invalidCommand = commandRegistry.listInvalid()[0];
  if (hasCommands && invalidCommand) {
    throw new Error(`Invalid command profile ${invalidCommand.path}: ${invalidCommand.error}`);
  }
  const commandSelections = parsed.commandSelections.map((selection) => {
    const profile = commandRegistry.resolve(selection.profile);
    assertCommandEffectAllowed(profile, selection.effect);
    return profile;
  });
  const commands = [...new Map(commandSelections.map((profile) => [profile.id, profile])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (commands.length > DEFINITION_LIMITS.commandProfileFilesPerNamespace * 3) {
    throw new Error("Too many pinned command profiles");
  }

  const measurementEnvironment = hasMeasurements
    ? options.measurementEnvironmentDescriptor ?? new HostMeasurementEnvironmentProvider().describe()
    : undefined;
  if (measurementEnvironment) assertMeasurementEnvironmentDescriptor(measurementEnvironment);

  const measurementRegistry = options.measurementProfileRegistry ?? new MeasurementProfileRegistry();
  if (hasMeasurements && !options.measurementProfileRegistry) {
    await measurementRegistry.refresh(cwd, {
      includeProject: options.includeProjectMeasurements ?? options.includeProjectProfiles === true,
    });
  }
  const invalidMeasurement = measurementRegistry.listInvalid()[0];
  if (hasMeasurements && invalidMeasurement) {
    throw new Error(`Invalid measurement profile ${invalidMeasurement.path}: ${invalidMeasurement.error}`);
  }
  const measurements = hasMeasurements ? measurementRegistry.list() : [];
  if (hasMeasurements && measurements.length === 0) throw new Error("No trusted measurement profiles are available");
  if (measurements.length > DEFINITION_LIMITS.measurementProfiles) throw new Error("Too many pinned measurement profiles");

  const verificationRegistry = options.verificationProfileRegistry ?? new VerificationProfileRegistry();
  if (hasVerifications && !options.verificationProfileRegistry) {
    await verificationRegistry.refresh(cwd, {
      includeProject: options.includeProjectVerifications ?? options.includeProjectProfiles === true,
    });
  }
  const invalidVerification = verificationRegistry.listInvalid()[0];
  if (hasVerifications && invalidVerification) {
    throw new Error(`Invalid verification profile ${invalidVerification.path}: ${invalidVerification.error}`);
  }
  const verificationSelections = parsed.verificationSelections.map((selection) =>
    verificationRegistry.resolve(selection.profile));
  const verifications = [...new Map(verificationSelections.map((profile) => [profile.id, profile])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (hasVerifications && verifications.length === 0) throw new Error("No trusted verification profiles are available");
  if (verifications.length > DEFINITION_LIMITS.verificationProfiles) throw new Error("Too many pinned verification profiles");

  const reviewerSelections = verifications.flatMap((verification) =>
    "profile" in verification.adversarialReview
      ? [{
          id: `verification-${verification.name}`,
          profile: verification.adversarialReview.profile,
          workspace: "snapshot" as const,
          network: "none" as const,
          resultMode: "value" as const,
          location: { line: 1, column: 1 },
        }]
      : []);
  const sourceSelections = [...parsed.agentSelections, ...reviewerSelections];

  const executor = options.executorDescriptor;
  if (executor) assertAgentExecutorDescriptor(executor);
  if (sourceSelections.length > 0 && !executor) {
    throw new Error("An agent executor descriptor is required for workflows containing agents");
  }
  if (sourceSelections.length > 0 && (!options.availableModels || options.availableModels.length === 0)) {
    throw new Error("Exact availableModels are required before launching workflow agents");
  }

  const profiles = new Map<string, AgentProfileRef>();
  const profileSelectors: Record<string, string> = {};
  for (const selection of sourceSelections) {
    const profile = profileRegistry.resolve(selection.profile);
    profiles.set(profile.id, profile);
    profileSelectors[selection.profile] = profile.id;
  }
  const profileSnapshots = [...profiles.values()].map(snapshotAgentProfile)
    .sort((left, right) => left.id.localeCompare(right.id));

  const routeRegistry = options.routeRegistry ?? new AgentRouteRegistry();
  if (!options.routeRegistry) {
    await routeRegistry.refresh({
      defaults: options.routeDefaults,
      filePath: options.routeFile,
      overrides: options.routeOverrides,
    });
  }
  const routeSnapshot = routeRegistry.snapshot(
    profileSnapshots.map((profile) => profile.id),
    options.availableModels ?? [],
  );
  assertRoutePolicy(routeSnapshot.routes, options.policy);
  const routesByProfile = new Map(routeSnapshot.routes.map((route) => [route.profileId, route]));
  const profilesById = new Map(profileSnapshots.map((profile) => [profile.id, profile]));

  const agentSelections: ResolvedAgentSelection[] = sourceSelections.map((selection) => {
    const profileId = profileSelectors[selection.profile];
    const profile = profileId ? profilesById.get(profileId) : undefined;
    const route = profileId ? routesByProfile.get(profileId) : undefined;
    if (!profile || !route || !executor) throw new Error(`Agent authority for ${selection.profile} was not resolved`);
    const tools = resolveAgentTools(profile, {
      workspace: selection.workspace,
      network: selection.network,
    }, executor);
    const provenance = {
      ...agentCallProvenance(profile, route, tools),
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
    };
    return {
      operationId: selection.id,
      profileId: profile.id,
      profileHash: profile.hash,
      routeId: route.id,
      routeHash: route.hash,
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
      tools,
      authorityHash: stableHash(provenance),
    };
  });

  const contextBundle = await captureContextBundle(root, options.projectGuidance);
  const body = {
    formatVersion: 1 as const,
    definitionSourceHash: parsed.sourceHash,
    projectRoot: root,
    projectCwd: cwd,
    profiles: profileSnapshots,
    profileSelectors: sortRecord(profileSelectors),
    routes: routeSnapshot.routes,
    routeSnapshotHash: routeSnapshot.hash,
    agentSelections,
    contextBundle,
    ...(executor ? { executor } : {}),
    ...(commandExecutor ? { commandExecutor } : {}),
    commands,
    measurements,
    verifications,
    ...(measurementEnvironment ? { measurementEnvironment } : {}),
    candidateCapable: parsed.metadata.capabilities.includes("candidate-write"),
  };
  return { ...body, hash: stableHash(body) };
}

/** Reopen checks host allow-lists only. It never hashes or revalidates credentials. */
export function validatePinnedExecutionPolicy(
  resources: PersistedWorkflowExecutionResources,
  policy: WorkflowExecutionPolicy | undefined,
): void {
  if (!policy) return;
  assertRoutePolicy(resources.routes, policy);
}

function assertRoutePolicy(routes: readonly AgentRouteSnapshot[], policy: WorkflowExecutionPolicy | undefined): void {
  const allowedModels = policy?.allowedModels ? new Set(policy.allowedModels) : undefined;
  const allowedThinking = policy?.allowedThinking ? new Set(policy.allowedThinking) : undefined;
  for (const route of routes) {
    if (allowedModels && !allowedModels.has(route.model)) {
      throw new Error(`Model ${route.model} routed for ${route.profileId} is denied by host policy`);
    }
    if (allowedThinking && !allowedThinking.has(route.thinking)) {
      throw new Error(`Thinking level ${route.thinking} routed for ${route.profileId} is denied by host policy`);
    }
  }
}

async function captureContextBundle(
  root: string,
  supplied: readonly TrustedProjectGuidance[] | undefined,
): Promise<AgentContextBundle> {
  const candidates = supplied ? [...supplied] : await discoverGuidance(root);
  if (candidates.length > DEFINITION_LIMITS.projectGuidanceFiles) throw new Error("Too many trusted project-guidance files");
  let total = 0;
  const entries: AgentContextEntry[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const normalized = candidate.text.replace(/\r\n?/g, "\n");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) {
      throw new Error(`Project guidance ${candidate.path} contains disallowed control characters`);
    }
    for (const scalar of normalized) {
      const codePoint = scalar.codePointAt(0)!;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        throw new Error(`Project guidance ${candidate.path} contains an unpaired surrogate`);
      }
    }
    const bytes = Buffer.byteLength(normalized);
    if (bytes > DEFINITION_LIMITS.projectGuidanceFileBytes) throw new Error(`Project guidance ${candidate.path} is too large`);
    total += bytes;
    if (total > DEFINITION_LIMITS.projectGuidanceTotalBytes) throw new Error("Trusted project guidance exceeds the total byte limit");
    const id = candidate.id ?? `context-${index + 1}`;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || ids.has(id)) {
      throw new Error(`Invalid or duplicate project-guidance id ${id}`);
    }
    ids.add(id);
    entries.push({ id, path: candidate.path, text: normalized, hash: stableHash({ path: candidate.path, text: normalized }) });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  return { entries, hash: stableHash(entries) };
}

async function discoverGuidance(root: string): Promise<TrustedProjectGuidance[]> {
  const result: TrustedProjectGuidance[] = [];
  for (const relative of ["AGENTS.md", ".pi/AGENTS.md"]) {
    const filePath = path.join(root, relative);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Project guidance must be a regular non-symlink file: ${relative}`);
      }
      if (stat.size > DEFINITION_LIMITS.projectGuidanceFileBytes) throw new Error(`Project guidance is too large: ${relative}`);
      result.push({ path: relative, text: await readBoundedTextFile(filePath, DEFINITION_LIMITS.projectGuidanceFileBytes) });
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}

function assertCommandExecutor(descriptor: HostCommandExecutorDescriptor | undefined): void {
  if (!descriptor) return;
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.id) ||
    descriptor.protocolVersion !== 1 ||
    !["bwrap-systemd", "fake"].includes(descriptor.sandbox)
  ) throw new Error("Host command executor descriptor is invalid");
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow cwd escapes its project root");
  }
}
