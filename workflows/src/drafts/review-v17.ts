import path from "node:path";
import { AgentProfileRegistry, snapshotAgentProfile, type AgentProfileRef } from "../agents/profiles.js";
import { AgentRouteRegistry, type AgentRouteMap } from "../agents/routes.js";
import type { AgentExecutorDescriptor } from "../agents/executor.js";
import { resolveAgentTools } from "../agents/tool-policy.js";
import { assertCommandEffectAllowed, CommandProfileRegistry } from "../commands/profiles.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { parseWorkflowV17 } from "../definition/workflow-v17-frontend.js";
import type { ParsedWorkflowV17 } from "../definition/workflow-v17-types.js";
import { MeasurementProfileRegistry } from "../measurements/profiles.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import {
  defaultWorkflowV17RegistryPolicy,
  readWorkflowV17RegistryPolicy,
  workflowV17Exposure,
} from "../registry/workflow-v17-policy.js";
import { loadWorkflowV17ControlDefinition } from "../runtime/control-worker-host-v17.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { VerificationProfileRegistry } from "../verification/profiles.js";
import type { WorkflowDraftRevision, WorkflowDraftSourceDiff } from "./types.js";
import type {
  WorkflowV17DraftDiagnostic,
  WorkflowV17DraftOperationAnalysis,
  WorkflowV17DraftResolvedProfile,
  WorkflowV17DraftReviewBody,
  WorkflowV17DraftReviewRecord,
} from "./types-v17.js";

export interface WorkflowV17DraftReviewOptions {
  cwd: string;
  includeProjectResources?: boolean;
  apiPath?: string;
  availableModels?: readonly string[];
  routeDefaults?: AgentRouteMap;
  profileRegistry?: AgentProfileRegistry;
  routeRegistry?: AgentRouteRegistry;
  measurementProfileRegistry?: MeasurementProfileRegistry;
  verificationProfileRegistry?: VerificationProfileRegistry;
  commandProfileRegistry?: CommandProfileRegistry;
  executorDescriptor?: AgentExecutorDescriptor;
}

/** Review exact inert TypeScript source. No run callback or effect is invoked. */
export async function reviewWorkflowV17Draft(
  draft: WorkflowDraftRevision,
  options: WorkflowV17DraftReviewOptions,
): Promise<WorkflowV17DraftReviewRecord> {
  const diagnostics: WorkflowV17DraftDiagnostic[] = [];
  const installed = await readInstalled(draft.targetPath, diagnostics);
  const sourceDiff = sourceDiffRecord(installed?.source, installed?.hash ?? null, draft.source, draft.sourceHash);
  const directory = path.dirname(draft.targetPath);
  let policy = defaultWorkflowV17RegistryPolicy(directory, draft.namespace);
  try {
    policy = await readWorkflowV17RegistryPolicy(directory, draft.namespace);
    info(diagnostics, "policy", `Current ${workflowV17Exposure(policy, draft.name)} exposure policy ${policy.hash}`);
  } catch (error) {
    diagnosticError(diagnostics, "policy", error);
  }

  let parsed: ParsedWorkflowV17 | undefined;
  let profiles: WorkflowV17DraftResolvedProfile[] = [];
  let controlLoad: WorkflowV17DraftReviewBody["definitionControlLoad"] = "skipped";
  try {
    parsed = parseWorkflowV17(draft.source, {
      fileName: draft.targetPath,
      ...(options.apiPath ? { apiPath: options.apiPath } : {}),
    });
    if (parsed.installedName !== draft.name) throw new Error("Workflow v17 draft frontend returned another installed name");
    info(diagnostics, "typecheck", "Strict TypeScript check passed against pi/workflows v17");
    info(diagnostics, "parse", `Parsed and reviewed ${draft.sourceHash}`);
    info(diagnostics, "schema", "Input and output schemas compiled successfully");
  } catch (error) {
    diagnosticError(diagnostics, /TypeScript|typecheck|diagnostic/iu.test(message(error)) ? "typecheck" : "parse", error);
  }

  if (parsed) {
    profiles = await validateResources(parsed, options, diagnostics);
    try {
      await loadWorkflowV17ControlDefinition(parsed);
      controlLoad = "passed";
      info(diagnostics, "control-load", "Reviewed definition loaded without invoking run()");
    } catch (error) {
      controlLoad = "failed";
      diagnosticError(diagnostics, "control-load", error);
    }
  }

  const operations = parsed ? operationAnalysis(parsed) : emptyOperationAnalysis();
  const capabilities = parsed ? [...parsed.review.capabilities] : [];
  const body: WorkflowV17DraftReviewBody = {
    formatVersion: 1,
    runtimeVersion: 17,
    draftId: draft.id,
    namespace: draft.namespace,
    name: draft.name,
    sourceHash: draft.sourceHash,
    targetPath: draft.targetPath,
    installedSourceHash: installed?.hash ?? null,
    valid: diagnostics.every(diagnostic => diagnostic.severity !== "error"),
    ...(parsed ? { definition: {
      ...(parsed.metadata.title ? { title: parsed.metadata.title } : {}),
      description: parsed.metadata.description,
      ...(parsed.metadata.concurrency !== undefined ? { concurrency: parsed.metadata.concurrency } : {}),
      currentExposure: workflowV17Exposure(policy, draft.name),
      policyHash: policy.hash,
    } } : {}),
    sourceDiff,
    capabilities,
    descriptors: parsed ? parsed.descriptors.map(descriptor => ({
      binding: descriptor.binding,
      kind: descriptor.kind,
      profile: descriptor.profile,
      ...(descriptor.kind === "agent-task" ? {
        workspace: descriptor.workspace,
        network: descriptor.network,
      } : { effect: descriptor.effect }),
      sourceSite: descriptor.identity.sourceSite,
    })) : [],
    profiles,
    commandProfiles: parsed ? [...parsed.review.commandProfiles] : [],
    measurementProfiles: parsed ? [...parsed.review.measurementProfiles] : [],
    verificationProfiles: parsed ? [...parsed.review.verificationProfiles] : [],
    dynamicResources: parsed ? structuredClone(parsed.review.dynamicResources) : [],
    candidateWrites: parsed ? structuredClone(parsed.review.candidateWrites) : [],
    authority: {
      candidateWrite: capabilities.includes("candidate-write"),
      mediatedNetwork: capabilities.includes("mediated-network"),
      hostCommand: capabilities.includes("host-command"),
      humanInput: capabilities.includes("human-input"),
      humanInteractionSites: parsed?.review.humanInteractionSites.length ?? 0,
      applySites: parsed?.review.applySites.length ?? 0,
    },
    operations,
    definitionControlLoad: controlLoad,
    diagnostics: diagnostics.slice(0, DEFINITION_LIMITS.draftDiagnostics),
  };
  const record = { ...body, reviewHash: stableHash(body) };
  if (Buffer.byteLength(stableJson(record), "utf8") > DEFINITION_LIMITS.draftReviewBytes) {
    throw new Error(`Workflow v17 draft review exceeds ${DEFINITION_LIMITS.draftReviewBytes} bytes`);
  }
  return Object.freeze(record);
}

async function validateResources(
  parsed: ParsedWorkflowV17,
  options: WorkflowV17DraftReviewOptions,
  diagnostics: WorkflowV17DraftDiagnostic[],
): Promise<WorkflowV17DraftResolvedProfile[]> {
  try {
    const includeProject = options.includeProjectResources === true;
    const profiles = options.profileRegistry ?? new AgentProfileRegistry();
    if (!options.profileRegistry) await profiles.refresh(options.cwd, { includeProject });
    const invalidProfile = profiles.listInvalid()[0];
    if (invalidProfile) throw new Error(`Invalid agent profile ${invalidProfile.path}: ${invalidProfile.error}`);

    const commands = options.commandProfileRegistry ?? new CommandProfileRegistry();
    if (parsed.review.commandProfiles.length && !options.commandProfileRegistry) {
      await commands.refresh(options.cwd, { includeProject });
    }
    const invalidCommand = commands.listInvalid()[0];
    if (parsed.review.commandProfiles.length && invalidCommand) {
      throw new Error(`Invalid command profile ${invalidCommand.path}: ${invalidCommand.error}`);
    }
    for (const descriptor of parsed.descriptors.filter(value => value.kind === "command-task")) {
      assertCommandEffectAllowed(commands.resolve(descriptor.profile), descriptor.effect);
    }

    const measurements = options.measurementProfileRegistry ?? new MeasurementProfileRegistry();
    if (parsed.review.measurementProfiles.length && !options.measurementProfileRegistry) {
      await measurements.refresh(options.cwd, { includeProject });
    }
    for (const selector of parsed.review.measurementProfiles) measurements.resolve(selector);

    const verifications = options.verificationProfileRegistry ?? new VerificationProfileRegistry();
    if (parsed.review.verificationProfiles.length && !options.verificationProfileRegistry) {
      await verifications.refresh(options.cwd, { includeProject });
    }
    const resolvedVerifications = parsed.review.verificationProfiles.map(selector => verifications.resolve(selector));

    const selections = [
      ...parsed.descriptors.filter(value => value.kind === "agent-task").map(descriptor => ({
        selector: descriptor.profile,
        workspace: descriptor.workspace,
        network: descriptor.network,
      })),
      ...resolvedVerifications.flatMap(verification => "profile" in verification.adversarialReview
        ? [{ selector: verification.adversarialReview.profile, workspace: "snapshot" as const, network: "none" as const }]
        : []),
    ];
    const resolved = selections.map(selection => ({ ...selection, profile: profiles.resolve(selection.selector) }));
    const unique = new Map<string, AgentProfileRef>();
    for (const selection of resolved) unique.set(selection.profile.id, selection.profile);
    if (unique.size === 0) {
      info(diagnostics, "profiles", `Resolved ${parsed.review.commandProfiles.length} command, ${parsed.review.measurementProfiles.length} static measurement, and ${parsed.review.verificationProfiles.length} verification profiles`);
      info(diagnostics, "routes", "No agent model routes are required");
      info(diagnostics, "resources", `${parsed.review.dynamicResources.length} invocation-selected resource site(s) require exact launch binding`);
      return [];
    }
    if (!options.executorDescriptor) throw new Error("An exact agent executor descriptor is required to review agent tool authority");
    const routes = options.routeRegistry ?? new AgentRouteRegistry();
    if (!options.routeRegistry) await routes.refresh({ defaults: options.routeDefaults });
    const routeSnapshot = routes.snapshot([...unique.keys()], options.availableModels ?? []);
    const routeByProfile = new Map(routeSnapshot.routes.map(route => [route.profileId, route]));
    for (const selection of resolved) {
      resolveAgentTools(snapshotAgentProfile(selection.profile), {
        workspace: selection.workspace,
        network: selection.network,
      }, options.executorDescriptor);
    }
    const bySelector = new Map<string, WorkflowV17DraftResolvedProfile>();
    for (const selection of resolved) {
      const route = routeByProfile.get(selection.profile.id);
      if (!route) throw new Error(`No exact route was resolved for ${selection.profile.id}`);
      bySelector.set(selection.selector, {
        selector: selection.selector,
        id: selection.profile.id,
        profileHash: selection.profile.hash,
        routeId: route.id,
        routeHash: route.hash,
        model: route.model,
        thinking: route.thinking,
      });
    }
    info(diagnostics, "profiles", `Resolved ${unique.size} semantic, ${parsed.review.commandProfiles.length} command, ${parsed.review.measurementProfiles.length} static measurement, and ${parsed.review.verificationProfiles.length} verification profiles`);
    info(diagnostics, "routes", `Resolved ${routeSnapshot.routes.length} exact model route(s)`);
    info(diagnostics, "resources", `${parsed.review.dynamicResources.length} invocation-selected resource site(s) are constrained by input schema`);
    return [...bySelector.values()].sort((left, right) => left.selector.localeCompare(right.selector));
  } catch (error) {
    diagnosticError(diagnostics, /route|model/iu.test(message(error)) ? "routes" : "profiles", error);
    return [];
  }
}

function operationAnalysis(parsed: ParsedWorkflowV17): WorkflowV17DraftOperationAnalysis {
  const byMethod: Record<string, number> = {};
  for (const operation of parsed.operations) byMethod[operation.method] = (byMethod[operation.method] ?? 0) + 1;
  return {
    staticSites: parsed.operations.length,
    byMethod: Object.fromEntries(Object.entries(byMethod).sort(([left], [right]) => left.localeCompare(right))),
    concurrentSites: (byMethod.parallel ?? 0) + (byMethod.map ?? 0),
    nativeLoops: structuredClone(parsed.review.nativeLoops),
    suspiciousUnboundedLoops: structuredClone(parsed.review.suspiciousUnboundedLoops),
    hostAdmissionLimit: DEFINITION_LIMITS.semanticOperations,
  };
}

function emptyOperationAnalysis(): WorkflowV17DraftOperationAnalysis {
  return { staticSites: 0, byMethod: {}, concurrentSites: 0, nativeLoops: [], suspiciousUnboundedLoops: [], hostAdmissionLimit: DEFINITION_LIMITS.semanticOperations };
}

async function readInstalled(filePath: string, diagnostics: WorkflowV17DraftDiagnostic[]) {
  try {
    const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes);
    return { source, hash: sha256(source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|no such file/iu.test(message(error))) return undefined;
    diagnosticError(diagnostics, "installed", error);
    return undefined;
  }
}

function sourceDiffRecord(
  installed: string | undefined,
  installedHash: string | null,
  draft: string,
  draftHash: string,
): WorkflowDraftSourceDiff {
  if (installed === draft) return { installedSourceHash: installedHash, draftSourceHash: draftHash, changed: false, preview: "", truncated: false };
  const before = installed?.replace(/\r\n?/gu, "\n").split("\n") ?? [];
  const after = draft.replace(/\r\n?/gu, "\n").split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const lines = [
    `--- ${installed ? "installed" : "/dev/null"}`,
    "+++ draft",
    `@@ -${prefix + 1},${before.length - prefix - suffix} +${prefix + 1},${after.length - prefix - suffix} @@`,
    ...before.slice(prefix, before.length - suffix).map(line => `-${line}`),
    ...after.slice(prefix, after.length - suffix).map(line => `+${line}`),
  ];
  const raw = lines.join("\n");
  const bytes = Buffer.from(raw, "utf8");
  const truncated = bytes.length > DEFINITION_LIMITS.draftDiffBytes;
  const preview = truncated ? bytes.subarray(0, DEFINITION_LIMITS.draftDiffBytes - 4).toString("utf8") + "\n…" : raw;
  return { installedSourceHash: installedHash, draftSourceHash: draftHash, changed: true, preview, truncated };
}

function info(diagnostics: WorkflowV17DraftDiagnostic[], stage: WorkflowV17DraftDiagnostic["stage"], messageValue: string): void {
  diagnostics.push({ stage, severity: "info", message: messageValue });
}
function diagnosticError(diagnostics: WorkflowV17DraftDiagnostic[], stage: WorkflowV17DraftDiagnostic["stage"], error: unknown): void {
  const location = error instanceof WorkflowScriptError
    && typeof error.location?.line === "number"
    && typeof error.location.column === "number"
    ? { line: error.location.line, column: error.location.column }
    : undefined;
  diagnostics.push({
    stage,
    severity: "error",
    message: message(error),
    ...(location ? { location } : {}),
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
