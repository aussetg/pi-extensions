import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutorDescriptor } from "../agents/executor.js";
import { AgentProfileRegistry } from "../agents/profiles.js";
import { AgentRouteRegistry } from "../agents/routes.js";
import { stableHash } from "../utils/hashes.js";
import { reviewWorkflowDraft, type WorkflowDraftReviewOptions } from "./review.js";
import { WorkflowDraftStore, type WorkflowDraftStoreOptions } from "./store.js";
import type {
  WorkflowDraftId,
  WorkflowDraftNamespace,
  WorkflowDraftPromotionChallenge,
  WorkflowDraftPromotionResult,
  WorkflowDraftReviewRecord,
  WorkflowDraftRevision,
  WorkflowDraftSummary,
} from "./types.js";

export interface WorkflowDraftServiceOptions extends WorkflowDraftStoreOptions {
  store?: WorkflowDraftStore;
  executorDescriptor?: AgentExecutorDescriptor;
  routeFile?: string;
}

export class WorkflowDraftService {
  readonly store: WorkflowDraftStore;
  private readonly executorDescriptor?: AgentExecutorDescriptor;
  private readonly routeFile?: string;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "getThinkingLevel">,
    options: WorkflowDraftServiceOptions = {},
  ) {
    this.store = options.store ?? new WorkflowDraftStore(options);
    this.executorDescriptor = options.executorDescriptor;
    this.routeFile = options.routeFile;
  }

  async create(
    input: { namespace: WorkflowDraftNamespace; name: string; source: string },
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftRevision> {
    this.assertNamespaceAllowed(input.namespace, ctx);
    return await this.store.create({ ...input, cwd: ctx.cwd });
  }

  async replace(
    input: {
      namespace: WorkflowDraftNamespace;
      name: string;
      source: string;
      expectedSourceHash: string;
    },
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftRevision> {
    this.assertNamespaceAllowed(input.namespace, ctx);
    return await this.store.replace({ ...input, cwd: ctx.cwd });
  }

  async validate(selector: string, ctx: ExtensionContext): Promise<WorkflowDraftReviewRecord> {
    const draft = await this.inspect(selector, ctx);
    return await reviewWorkflowDraft(draft, await this.reviewOptions(ctx));
  }

  async explain(selector: string, ctx: ExtensionContext): Promise<WorkflowDraftReviewRecord> {
    return await this.validate(selector, ctx);
  }

  async list(ctx: ExtensionContext, namespace?: WorkflowDraftNamespace): Promise<WorkflowDraftSummary[]> {
    if (namespace) this.assertNamespaceAllowed(namespace, ctx);
    const drafts = await this.store.list(ctx.cwd, namespace);
    return drafts.filter((draft) => draft.namespace !== "project" || ctx.isProjectTrusted());
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

  async promotionChallenge(selector: string, ctx: ExtensionContext): Promise<{
    challenge: WorkflowDraftPromotionChallenge;
    review: WorkflowDraftReviewRecord;
  }> {
    const review = await this.validate(selector, ctx);
    if (!review.valid) throw new Error(`Workflow draft ${review.draftId} is invalid and cannot be promoted`);
    const body = {
      formatVersion: 1 as const,
      draftId: review.draftId,
      draftHash: review.sourceHash,
      targetNamespace: review.namespace,
      targetPath: review.targetPath,
      installedSourceHash: review.installedSourceHash,
      reviewHash: review.reviewHash,
    };
    return { challenge: { ...body, challengeHash: stableHash(body) }, review };
  }

  async promote(
    selector: string,
    challengeHash: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowDraftPromotionResult> {
    const { challenge, review } = await this.promotionChallenge(selector, ctx);
    if (challenge.challengeHash !== challengeHash) {
      throw new Error("Workflow draft promotion challenge is stale");
    }
    const installed = await this.store.installAndConsume({
      namespace: review.namespace,
      name: review.name,
      cwd: ctx.cwd,
      expectedDraftHash: challenge.draftHash,
      expectedInstalledSourceHash: challenge.installedSourceHash,
    });
    return {
      id: review.draftId,
      sourceHash: installed.sourceHash,
      installedPath: installed.targetPath,
      reviewHash: review.reviewHash,
    };
  }

  private async reviewOptions(ctx: ExtensionContext): Promise<WorkflowDraftReviewOptions> {
    const includeProject = ctx.isProjectTrusted();
    const profiles = new AgentProfileRegistry();
    await profiles.refresh(ctx.cwd, { includeProject });
    const availableModels = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    const selectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : availableModels[0];
    const defaults = selectedModel
      ? Object.fromEntries(profiles.list().map((profile) => [
          profile.id,
          { model: selectedModel, thinking: this.pi.getThinkingLevel() },
        ]))
      : {};
    const routes = new AgentRouteRegistry();
    await routes.refresh({ defaults, ...(this.routeFile ? { filePath: this.routeFile } : {}) });
    return {
      cwd: ctx.cwd,
      includeProjectResources: includeProject,
      availableModels,
      profileRegistry: profiles,
      routeRegistry: routes,
      ...(this.executorDescriptor ? { executorDescriptor: this.executorDescriptor } : {}),
    };
  }

  private assertNamespaceAllowed(namespace: WorkflowDraftNamespace, ctx: ExtensionContext): void {
    if (namespace === "project" && !ctx.isProjectTrusted()) {
      throw new Error("Project workflow drafts require a trusted project");
    }
  }
}

export function parseDraftSelector(selector: string): { namespace: WorkflowDraftNamespace; name: string; id: WorkflowDraftId } {
  const match = /^(user|project):([a-z][a-z0-9_-]{0,63})$/.exec(selector);
  if (!match) throw new Error("Workflow draft selector must be an exact user:NAME or project:NAME id");
  return { namespace: match[1] as WorkflowDraftNamespace, name: match[2]!, id: selector as WorkflowDraftId };
}
