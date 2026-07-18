import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutorDescriptor } from "../agents/executor.js";
import type { WorkflowExposure } from "../registry/workflow-policy.js";
import { stableHash } from "../utils/hashes.js";
import type { WorkflowDraftReviewOptions } from "./review.js";
import { WorkflowDraftStore, type WorkflowDraftStoreOptions } from "./store.js";
import type {
  WorkflowDraftId,
  WorkflowDraftNamespace,
  WorkflowDraftRevision,
  WorkflowDraftSummary,
} from "./types.js";
import type {
  WorkflowDraftPromotionChallenge,
  WorkflowDraftPromotionResult,
  WorkflowDraftReviewRecord,
} from "./promotion-types.js";

export interface WorkflowDraftServiceOptions extends WorkflowDraftStoreOptions {
  store?: WorkflowDraftStore;
  executorDescriptor?: AgentExecutorDescriptor;
  routeFile?: string;
  apiPath?: string;
}

export function parseDraftSelector(selector: string): { namespace: WorkflowDraftNamespace; name: string; id: WorkflowDraftId } {
  const match = /^(user|project):([a-z][a-z0-9_-]{0,63})$/.exec(selector);
  if (!match) throw new Error("Workflow draft selector must be an exact user:NAME or project:NAME id");
  return { namespace: match[1] as WorkflowDraftNamespace, name: match[2]!, id: selector as WorkflowDraftId };
}

/** Staged authoring service; it installs only inert .flow.ts definitions. */
export class WorkflowDraftService {
  readonly store: WorkflowDraftStore;
  private readonly executorDescriptor?: AgentExecutorDescriptor;
  private readonly routeFile?: string;
  private readonly apiPath?: string;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "getThinkingLevel">,
    options: WorkflowDraftServiceOptions = {},
  ) {
    this.store = options.store ?? new WorkflowDraftStore(options);
    this.executorDescriptor = options.executorDescriptor;
    this.routeFile = options.routeFile;
    this.apiPath = options.apiPath;
  }

  async create(
    input: { namespace: WorkflowDraftNamespace; name: string; source: string },
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftRevision> {
    this.assertNamespaceAllowed(input.namespace, ctx);
    return await this.store.create({ ...input, cwd: ctx.cwd });
  }

  async replace(
    input: { namespace: WorkflowDraftNamespace; name: string; source: string; expectedSourceHash: string },
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftRevision> {
    this.assertNamespaceAllowed(input.namespace, ctx);
    return await this.store.replace({ ...input, cwd: ctx.cwd });
  }

  async validate(selector: string, ctx: ExtensionContext): Promise<WorkflowDraftReviewRecord> {
    const draft = await this.inspect(selector, ctx);
    const { reviewWorkflowDraft } = await import("./review.js");
    return await reviewWorkflowDraft(draft, await this.reviewOptions(ctx));
  }

  async list(ctx: ExtensionContext, namespace?: WorkflowDraftNamespace): Promise<WorkflowDraftSummary[]> {
    if (namespace) this.assertNamespaceAllowed(namespace, ctx);
    const drafts = await this.store.list(ctx.cwd, namespace);
    return drafts.filter(draft => draft.namespace !== "project" || ctx.isProjectTrusted());
  }

  async inspect(selector: string, ctx: ExtensionContext): Promise<WorkflowDraftRevision> {
    const { namespace, name } = parseDraftSelector(selector);
    this.assertNamespaceAllowed(namespace, ctx);
    return await this.store.inspect(namespace, name, ctx.cwd);
  }

  async discard(selector: string, ctx: ExtensionContext, expectedSourceHash?: string): Promise<void> {
    const { namespace, name } = parseDraftSelector(selector);
    this.assertNamespaceAllowed(namespace, ctx);
    await this.store.discard(namespace, name, ctx.cwd, expectedSourceHash);
  }

  async promotionChallenge(
    selector: string,
    targetExposure: WorkflowExposure,
    ctx: ExtensionContext,
  ): Promise<{ challenge: WorkflowDraftPromotionChallenge; review: WorkflowDraftReviewRecord }> {
    const review = await this.validate(selector, ctx);
    if (!review.valid || !review.definition) throw new Error(`Workflow draft ${review.draftId} is invalid and cannot be promoted`);
    const body = {
      draftId: review.draftId,
      draftHash: review.sourceHash,
      targetNamespace: review.namespace,
      targetPath: review.targetPath,
      installedSourceHash: review.installedSourceHash,
      currentPolicyHash: review.definition.policyHash,
      targetExposure,
      reviewHash: review.reviewHash,
    };
    return { challenge: { ...body, challengeHash: stableHash(body) }, review };
  }

  async promote(
    selector: string,
    targetExposure: WorkflowExposure,
    challengeHash: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftPromotionResult> {
    const selected = parseDraftSelector(selector);
    this.assertNamespaceAllowed(selected.namespace, ctx);
    const resumed = await this.store.resumePromotion({
      namespace: selected.namespace,
      name: selected.name,
      cwd: ctx.cwd,
      challengeHash,
      exposure: targetExposure,
    });
    if (resumed) return {
      id: selected.id,
      sourceHash: resumed.sourceHash,
      installedPath: resumed.targetPath,
      exposure: resumed.exposure,
      policyHash: resumed.policyHash,
      reviewHash: resumed.reviewHash,
    };
    const { challenge, review } = await this.promotionChallenge(selector, targetExposure, ctx);
    if (challenge.challengeHash !== challengeHash) throw new Error("Workflow draft promotion challenge is stale");
    const installed = await this.store.installAndConsume({
      namespace: review.namespace,
      name: review.name,
      cwd: ctx.cwd,
      expectedDraftHash: challenge.draftHash,
      expectedInstalledSourceHash: challenge.installedSourceHash,
      expectedPolicyHash: challenge.currentPolicyHash,
      exposure: challenge.targetExposure,
      reviewHash: challenge.reviewHash,
      challengeHash: challenge.challengeHash,
    });
    return {
      id: review.draftId,
      sourceHash: installed.sourceHash,
      installedPath: installed.targetPath,
      exposure: installed.exposure,
      policyHash: installed.policyHash,
      reviewHash: review.reviewHash,
    };
  }

  private async reviewOptions(ctx: ExtensionContext): Promise<WorkflowDraftReviewOptions> {
    const [agents, routesModule, measurementsModule] = await Promise.all([
      import("../agents/profiles.js"),
      import("../agents/routes.js"),
      import("../measurements/profiles.js"),
    ]);
    const includeProject = ctx.isProjectTrusted();
    const profiles = new agents.AgentProfileRegistry();
    await profiles.refresh(ctx.cwd, { includeProject });
    const availableModels = ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`);
    const selectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : availableModels[0];
    const defaults = selectedModel
      ? Object.fromEntries(profiles.list().map(profile => [profile.id, {
          model: selectedModel,
          thinking: this.pi.getThinkingLevel(),
        }]))
      : {};
    const routes = new routesModule.AgentRouteRegistry();
    await routes.refresh({ defaults, ...(this.routeFile ? { filePath: this.routeFile } : {}) });
    const measurements = new measurementsModule.MeasurementProfileRegistry();
    await measurements.refresh(ctx.cwd, { includeProject });
    return {
      cwd: ctx.cwd,
      includeProjectResources: includeProject,
      ...(this.apiPath ? { apiPath: this.apiPath } : {}),
      availableModels,
      profileRegistry: profiles,
      routeRegistry: routes,
      measurementProfileRegistry: measurements,
      ...(this.executorDescriptor ? { executorDescriptor: this.executorDescriptor } : {}),
    };
  }

  private assertNamespaceAllowed(namespace: WorkflowDraftNamespace, ctx: ExtensionContext): void {
    if (namespace === "project" && !ctx.isProjectTrusted()) {
      throw new Error("Project workflow drafts require a trusted project");
    }
  }
}
