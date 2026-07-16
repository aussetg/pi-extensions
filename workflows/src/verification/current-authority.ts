import { agentCallProvenance } from "../agents/call-identity.js";
import type { AgentExecutor } from "../agents/executor.js";
import type { PreparedWorkflowExecutionResources } from "../agents/resources.js";
import {
  AgentProfileRegistry,
  snapshotAgentProfile,
  type AgentProfileRegistryRefreshOptions,
} from "../agents/profiles.js";
import {
  AgentRouteRegistry,
  type AgentRouteRegistryRefreshOptions,
} from "../agents/routes.js";
import { resolveAgentTools } from "../agents/tool-policy.js";
import type { HostCommandExecutor } from "../commands/executor.js";
import type { VerificationRecord } from "../runtime/durable-types.js";
import { stableHash } from "../utils/hashes.js";
import {
  verificationGateEnvironmentHash,
  type VerificationReviewerEnvironment,
} from "./environment.js";
import {
  VerificationProfileRegistry,
  type VerificationProfileRegistryRefreshOptions,
  type VerificationProfileSnapshot,
} from "./profiles.js";

export interface CurrentVerificationBinding {
  profileHash: string;
  gateEnvironmentHash: string;
}

export interface CurrentVerificationAuthorityOptions {
  projectCwd: string;
  resources: PreparedWorkflowExecutionResources;
  commandExecutor: Pick<HostCommandExecutor, "describe">;
  agentExecutor: Pick<AgentExecutor, "describe">;
  verificationRegistry?: Omit<VerificationProfileRegistryRefreshOptions, "includeProject">;
  agentProfileRegistry?: Omit<AgentProfileRegistryRefreshOptions, "includeProject">;
  routeRegistry?: Omit<AgentRouteRegistryRefreshOptions, "defaults">;
}

/** Resolve verification policy and tooling from the host as it exists at apply time. */
export class CurrentVerificationAuthority {
  constructor(private readonly options: CurrentVerificationAuthorityOptions) {}

  async binding(verification: VerificationRecord): Promise<CurrentVerificationBinding> {
    const profile = await this.currentVerificationProfile(verification);
    if (profile.hash !== verification.profileHash) {
      throw new Error(`Verification profile ${verification.profileId} changed after verification`);
    }
    const reviewer = "profile" in profile.adversarialReview
      ? await this.currentReviewer(profile)
      : undefined;
    return {
      profileHash: profile.hash,
      gateEnvironmentHash: verificationGateEnvironmentHash(
        profile,
        this.options.commandExecutor.describe(),
        reviewer,
      ),
    };
  }

  private async currentVerificationProfile(
    verification: VerificationRecord,
  ): Promise<VerificationProfileSnapshot> {
    const registry = new VerificationProfileRegistry();
    await registry.refresh(this.options.projectCwd, {
      ...this.options.verificationRegistry,
      includeProject: verification.profileId.startsWith("project:"),
    });
    return registry.resolve(verification.profileId);
  }

  private async currentReviewer(
    verificationProfile: VerificationProfileSnapshot,
  ): Promise<VerificationReviewerEnvironment> {
    const sourceId = `verification-${verificationProfile.name}`;
    const matches = this.options.resources.agentSelections.filter((selection) => selection.operationId === sourceId);
    if (matches.length !== 1) throw new Error(`Verification reviewer ${sourceId} has no unique pinned authority`);
    const pinned = matches[0]!;
    if (pinned.workspace !== "snapshot" || pinned.network !== "none" || pinned.resultMode !== "value") {
      throw new Error(`Verification reviewer ${sourceId} has invalid pinned authority`);
    }

    const profiles = new AgentProfileRegistry();
    await profiles.refresh(this.options.projectCwd, {
      ...this.options.agentProfileRegistry,
      includeProject: pinned.profileId.startsWith("project:"),
    });
    const profile = snapshotAgentProfile(profiles.resolve(pinned.profileId));

    const pinnedRoute = this.options.resources.routes.find((route) =>
      route.id === pinned.routeId && route.profileId === pinned.profileId);
    if (!pinnedRoute) throw new Error(`Verification reviewer ${sourceId} has no pinned route`);
    const routes = new AgentRouteRegistry();
    await routes.refresh({
      ...this.options.routeRegistry,
      defaults: {
        [profile.id]: { model: pinnedRoute.model, thinking: pinnedRoute.thinking },
      },
    });
    const route = routes.resolve(profile.id);
    const tools = resolveAgentTools(profile, { workspace: "snapshot", network: "none" }, this.options.agentExecutor.describe());
    const authorityHash = stableHash({
      ...agentCallProvenance(profile, route, tools),
      workspace: "snapshot",
      network: "none",
      resultMode: "value",
    });
    return { profileId: profile.id, routeId: route.id, authorityHash };
  }
}
