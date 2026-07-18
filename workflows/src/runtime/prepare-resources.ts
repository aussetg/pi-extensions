import type { AgentExecutorDescriptor, AgentThinkingLevel } from "../agents/executor.js";
import { AgentProfileRegistry, snapshotAgentProfile } from "../agents/profiles.js";
import { AgentRouteRegistry } from "../agents/routes.js";
import { resolveAgentTools } from "../agents/tool-policy.js";
import type { HostCommandExecutorDescriptor } from "../commands/executor.js";
import { assertCommandEffectAllowed, CommandProfileRegistry } from "../commands/profiles.js";
import type { ParsedWorkflow } from "../definition/workflow-types.js";
import type { MeasurementEnvironmentDescriptor } from "../measurements/environment.js";
import { MeasurementProfileRegistry } from "../measurements/profiles.js";
import type { JsonObject } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { VerificationProfileRegistry } from "../verification/profiles.js";
import {
  workflowStaticEffectResources,
  type WorkflowStaticEffectResources,
} from "./effect-adapters.js";

export interface PrepareWorkflowResourcesOptions {
  workflow: ParsedWorkflow;
  definitionHash: string;
  cwd: string;
  includeProject: boolean;
  availableModels: readonly string[];
  defaultModel?: string;
  thinking: AgentThinkingLevel;
  agentExecutor: AgentExecutorDescriptor;
  commandExecutor: HostCommandExecutorDescriptor;
  measurementEnvironment: MeasurementEnvironmentDescriptor;
}

export interface PreparedWorkflowResources {
  static: WorkflowStaticEffectResources;
  measurementProfiles: MeasurementProfileRegistry;
  routeSnapshotHash: string;
  contextIdentityHash: string;
}

/** Resolve every static descriptor and host protocol before a run directory is admitted. */
export async function prepareWorkflowResources(
  options: PrepareWorkflowResourcesOptions,
): Promise<PreparedWorkflowResources> {
  const profiles = new AgentProfileRegistry();
  await profiles.refresh(options.cwd, { includeProject: options.includeProject });
  const invalidProfile = profiles.listInvalid()[0];
  if (invalidProfile) throw new Error(`Invalid agent profile ${invalidProfile.path}: ${invalidProfile.error}`);

  const agentSelectors = new Set(options.workflow.descriptors
    .filter(descriptor => descriptor.kind === "agent-task")
    .map(descriptor => descriptor.profile));

  const verifications = new VerificationProfileRegistry();
  if (options.workflow.review.verificationProfiles.length) {
    await verifications.refresh(options.cwd, { includeProject: options.includeProject });
  }
  const verificationProfiles = options.workflow.review.verificationProfiles.map(selector => verifications.resolve(selector));
  for (const verification of verificationProfiles) {
    if ("profile" in verification.adversarialReview) agentSelectors.add(verification.adversarialReview.profile);
  }

  const snapshots = new Map<string, ReturnType<typeof snapshotAgentProfile>>();
  const selectorIds = new Map<string, string>();
  for (const selector of agentSelectors) {
    const profile = snapshotAgentProfile(profiles.resolve(selector));
    snapshots.set(profile.id, profile);
    selectorIds.set(selector, profile.id);
  }
  if (snapshots.size && (!options.defaultModel || !options.availableModels.includes(options.defaultModel))) {
    throw new Error("Workflow agent resources require one exact available default model");
  }
  const routes = new AgentRouteRegistry();
  if (snapshots.size) {
    await routes.refresh({
      defaults: Object.fromEntries([...snapshots.keys()].map(id => [id, {
        model: options.defaultModel!, thinking: options.thinking,
      }])),
    });
  }
  const routeSnapshot = routes.snapshot([...snapshots.keys()], options.availableModels);
  const routesByProfile = new Map(routeSnapshot.routes.map(route => [route.profileId, route]));

  const agentBindings: Record<string, { selector: string; authority: JsonObject }> = {};
  for (const descriptor of options.workflow.descriptors.filter(value => value.kind === "agent-task")) {
    const profileId = selectorIds.get(descriptor.profile)!;
    const profile = snapshots.get(profileId)!;
    const route = routesByProfile.get(profileId);
    if (!route) throw new Error(`No exact route for ${descriptor.profile}`);
    const tools = resolveAgentTools(profile, {
      workspace: descriptor.workspace,
      network: descriptor.network,
    }, options.agentExecutor);
    agentBindings[descriptor.identity.sourceSite] = {
      selector: descriptor.profile,
      authority: jsonObject({
        profile,
        route,
        tools,
        executor: options.agentExecutor,
        profileHash: profile.hash,
        routeHash: route.hash,
      }),
    };
  }

  const commands = new CommandProfileRegistry();
  if (options.workflow.review.commandProfiles.length) {
    await commands.refresh(options.cwd, { includeProject: options.includeProject });
  }
  const commandBindings: Record<string, { selector: string; authority: JsonObject }> = {};
  for (const descriptor of options.workflow.descriptors.filter(value => value.kind === "command-task")) {
    const profile = commands.resolve(descriptor.profile);
    assertCommandEffectAllowed(profile, descriptor.effect);
    commandBindings[descriptor.identity.sourceSite] = {
      selector: descriptor.profile,
      authority: jsonObject({
        profile,
        executor: options.commandExecutor,
        profileHash: profile.hash,
        executorHash: stableHash(options.commandExecutor),
      }),
    };
  }

  const verificationBindings: Record<string, { selector: string; authority: JsonObject }> = {};
  for (const profile of verificationProfiles) {
    let reviewer: JsonObject | undefined;
    if ("profile" in profile.adversarialReview) {
      const profileId = selectorIds.get(profile.adversarialReview.profile)!;
      const agentProfile = snapshots.get(profileId)!;
      const route = routesByProfile.get(profileId)!;
      const tools = resolveAgentTools(agentProfile, { workspace: "candidate", network: "none" }, options.agentExecutor);
      reviewer = jsonObject({
        profile: agentProfile, route, tools, executor: options.agentExecutor,
        profileHash: agentProfile.hash, routeHash: route.hash,
      });
    }
    const environmentHash = stableHash({
      profileHash: profile.hash,
      commandExecutor: options.commandExecutor,
      reviewer: reviewer ?? null,
    });
    verificationBindings[profile.id] = {
      selector: profile.id,
      authority: jsonObject({
        profile,
        commandExecutor: options.commandExecutor,
        ...(reviewer ? { reviewer } : {}),
        profileHash: profile.hash,
        environmentHash,
      }),
    };
  }

  const measurements = new MeasurementProfileRegistry();
  if (options.workflow.operations.some(operation => operation.method === "measure")) {
    await measurements.refresh(options.cwd, { includeProject: options.includeProject });
  }
  const staticMeasurements = Object.fromEntries(options.workflow.review.measurementProfiles.map(selector => {
    const profile = measurements.resolve(selector);
    return [selector, profile];
  }));
  const usesMeasurements = options.workflow.operations.some(operation => operation.method === "measure");
  const resources = workflowStaticEffectResources({
    workflow: options.workflow,
    definitionHash: options.definitionHash,
    agents: agentBindings,
    commands: commandBindings,
    verifications: verificationBindings,
    measurements: staticMeasurements,
    ...(usesMeasurements ? {
      measurementRuntime: {
        executor: options.commandExecutor as unknown as JsonObject,
        environment: options.measurementEnvironment as unknown as JsonObject,
      },
    } : {}),
  });
  return {
    static: resources,
    measurementProfiles: measurements,
    routeSnapshotHash: routeSnapshot.hash,
    contextIdentityHash: stableHash({
      definitionHash: options.definitionHash,
      staticResourcesHash: resources.hash,
      routeSnapshotHash: routeSnapshot.hash,
    }),
  };
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
