import { AgentProfileRegistry, snapshotAgentProfile, type AgentProfileRef } from "../agents/profiles.js";
import { AgentRouteRegistry, type AgentRouteMap } from "../agents/routes.js";
import { resolveAgentTools } from "../agents/tool-policy.js";
import type { AgentExecutorDescriptor } from "../agents/executor.js";
import {
  assertCommandEffectAllowed,
  CommandProfileRegistry,
} from "../commands/profiles.js";
import type { ParsedStructuredWorkflow } from "../definition/types.js";
import { parseStructuredWorkflow } from "../definition/workflow-definition.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { MeasurementProfileRegistry } from "../measurements/profiles.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { loadControlDefinition } from "../runtime/control-worker-host.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { VerificationProfileRegistry } from "../verification/profiles.js";
import type {
  WorkflowDraftDiagnostic,
  WorkflowDraftOperationAnalysis,
  WorkflowDraftResolvedProfile,
  WorkflowDraftReviewBody,
  WorkflowDraftReviewRecord,
  WorkflowDraftRevision,
  WorkflowDraftSourceDiff,
} from "./types.js";

export interface WorkflowDraftReviewOptions {
  cwd: string;
  includeProjectResources?: boolean;
  availableModels?: readonly string[];
  routeDefaults?: AgentRouteMap;
  profileRegistry?: AgentProfileRegistry;
  routeRegistry?: AgentRouteRegistry;
  measurementProfileRegistry?: MeasurementProfileRegistry;
  verificationProfileRegistry?: VerificationProfileRegistry;
  commandProfileRegistry?: CommandProfileRegistry;
  executorDescriptor?: AgentExecutorDescriptor;
}

/** Validate one exact immutable draft revision without running its run() body. */
export async function reviewWorkflowDraft(
  draft: WorkflowDraftRevision,
  options: WorkflowDraftReviewOptions,
): Promise<WorkflowDraftReviewRecord> {
  const diagnostics: WorkflowDraftDiagnostic[] = [];
  const installed = await readInstalled(draft.targetPath, diagnostics);
  const sourceDiff = sourceDiffRecord(installed?.source, installed?.hash ?? null, draft.source, draft.sourceHash);
  let parsed: ParsedStructuredWorkflow | undefined;
  let profiles: WorkflowDraftResolvedProfile[] = [];
  let controlLoad: WorkflowDraftReviewBody["definitionControlLoad"] = "skipped";

  try {
    parsed = parseStructuredWorkflow(draft.source);
    if (parsed.metadata.name !== draft.name) {
      throw new WorkflowScriptError(`Draft definition name ${parsed.metadata.name} must match draft name ${draft.name}`);
    }
    info(diagnostics, "parse", `Parsed ${draft.sourceHash}`);
    info(diagnostics, "schema", "Input and output schemas compiled successfully");
  } catch (error) {
    diagnosticError(diagnostics, "parse", error);
  }

  if (parsed) {
    profiles = await validateResources(parsed, options, diagnostics);
    const operations = operationAnalysis(parsed);
    if (operations.staticSites > DEFINITION_LIMITS.semanticOperations) {
      diagnosticError(diagnostics, "operations", new Error(
        `Workflow has ${operations.staticSites} static operation sites, above the host limit ${DEFINITION_LIMITS.semanticOperations}`,
      ));
    } else {
      info(
        diagnostics,
        "operations",
        `${operations.staticSites} static sites; host admits at most ${operations.hostAdmissionLimit} operations`,
      );
    }
    try {
      await loadControlDefinition(parsed.executableSource, parsed.metadata.name);
      controlLoad = "passed";
      info(diagnostics, "control-load", "Definition loaded in the constrained control process without invoking run()");
    } catch (error) {
      controlLoad = "failed";
      diagnosticError(diagnostics, "control-load", error);
    }
  }

  const operations = parsed ? operationAnalysis(parsed) : emptyOperationAnalysis();
  const commandProfiles = parsed ? boundedUnique(parsed.review.commandProfiles, "command profiles", diagnostics) : [];
  const measurementProfiles = parsed ? boundedUnique(parsed.review.measurementProfiles, "measurement profiles", diagnostics) : [];
  const verificationProfiles = parsed ? boundedUnique(parsed.review.verificationProfiles, "verification profiles", diagnostics) : [];
  const declared = parsed ? [...parsed.metadata.capabilities] : [];
  const derived = parsed ? [...parsed.review.capabilities] : [];
  const body: WorkflowDraftReviewBody = {
    formatVersion: 1,
    draftId: draft.id,
    namespace: draft.namespace,
    name: draft.name,
    sourceHash: draft.sourceHash,
    targetPath: draft.targetPath,
    installedSourceHash: installed?.hash ?? null,
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    ...(parsed ? {
      definition: {
        name: parsed.metadata.name,
        ...(parsed.metadata.title ? { title: parsed.metadata.title } : {}),
        description: parsed.metadata.description,
        modelVisible: parsed.metadata.modelVisible,
        ...(parsed.metadata.maxParallelism !== undefined ? { maxParallelism: parsed.metadata.maxParallelism } : {}),
      },
    } : {}),
    sourceDiff,
    capabilities: { declared, derived },
    profiles,
    commandProfiles,
    measurementProfiles,
    verificationProfiles,
    authority: {
      candidateWrite: declared.includes("candidate-write"),
      mediatedNetwork: declared.includes("mediated-network"),
      hostCommand: declared.includes("host-command"),
      humanInput: declared.includes("human-input"),
      applySites: parsed?.review.applySiteCount ?? 0,
    },
    operations,
    definitionControlLoad: controlLoad,
    diagnostics: diagnostics.slice(0, DEFINITION_LIMITS.draftDiagnostics),
  };
  const record = { ...body, reviewHash: stableHash(body) };
  if (Buffer.byteLength(stableJson(record)) > DEFINITION_LIMITS.draftReviewBytes) {
    throw new Error(`Workflow draft review exceeds ${DEFINITION_LIMITS.draftReviewBytes} bytes`);
  }
  return Object.freeze(record);
}

async function validateResources(
  parsed: ParsedStructuredWorkflow,
  options: WorkflowDraftReviewOptions,
  diagnostics: WorkflowDraftDiagnostic[],
): Promise<WorkflowDraftResolvedProfile[]> {
  const profileRegistry = options.profileRegistry ?? new AgentProfileRegistry();
  try {
    if (!options.profileRegistry) {
      await profileRegistry.refresh(options.cwd, { includeProject: options.includeProjectResources === true });
    }
    const invalid = profileRegistry.listInvalid()[0];
    if (invalid) throw new Error(`Invalid agent profile ${invalid.path}: ${invalid.error}`);

    const commandRegistry = options.commandProfileRegistry ?? new CommandProfileRegistry();
    if (parsed.commandSelections.length > 0 && !options.commandProfileRegistry) {
      await commandRegistry.refresh(options.cwd, { includeProject: options.includeProjectResources === true });
    }
    const invalidCommand = commandRegistry.listInvalid()[0];
    if (parsed.commandSelections.length > 0 && invalidCommand) {
      throw new Error(`Invalid command profile ${invalidCommand.path}: ${invalidCommand.error}`);
    }
    for (const selection of parsed.commandSelections) {
      assertCommandEffectAllowed(commandRegistry.resolve(selection.profile), selection.effect);
    }

    const measurementRegistry = options.measurementProfileRegistry ?? new MeasurementProfileRegistry();
    if (parsed.measurementSelections.length > 0 && !options.measurementProfileRegistry) {
      await measurementRegistry.refresh(options.cwd, { includeProject: options.includeProjectResources === true });
    }
    const invalidMeasurement = measurementRegistry.listInvalid()[0];
    if (parsed.measurementSelections.length > 0 && invalidMeasurement) {
      throw new Error(`Invalid measurement profile ${invalidMeasurement.path}: ${invalidMeasurement.error}`);
    }
    for (const selection of parsed.measurementSelections) measurementRegistry.resolve(selection.profile);

    const verificationRegistry = options.verificationProfileRegistry ?? new VerificationProfileRegistry();
    if (parsed.verificationSelections.length > 0 && !options.verificationProfileRegistry) {
      await verificationRegistry.refresh(options.cwd, { includeProject: options.includeProjectResources === true });
    }
    const invalidVerification = verificationRegistry.listInvalid()[0];
    if (parsed.verificationSelections.length > 0 && invalidVerification) {
      throw new Error(`Invalid verification profile ${invalidVerification.path}: ${invalidVerification.error}`);
    }
    const verifications = parsed.verificationSelections.map((selection) => verificationRegistry.resolve(selection.profile));

    const selectors = [
      ...parsed.agentSelections.map((selection) => ({
        selector: selection.profile,
        workspace: selection.workspace,
        network: selection.network,
      })),
      ...verifications.flatMap((verification) => "profile" in verification.adversarialReview
        ? [{ selector: verification.adversarialReview.profile, workspace: "snapshot" as const, network: "none" as const }]
        : []),
    ];
    const resolvedSelections = selectors.map((selection) => ({ ...selection, profile: profileRegistry.resolve(selection.selector) }));
    const uniqueProfiles = new Map<string, AgentProfileRef>();
    for (const selection of resolvedSelections) uniqueProfiles.set(selection.profile.id, selection.profile);
    if (uniqueProfiles.size > DEFINITION_LIMITS.profileFilesPerNamespace * 3) {
      throw new Error("Workflow resolves too many semantic profiles");
    }
    info(
      diagnostics,
      "profiles",
      `Resolved ${uniqueProfiles.size} semantic, ${parsed.commandSelections.length} command, ${parsed.measurementSelections.length} measurement, and ${parsed.verificationSelections.length} verification profiles`,
    );

    if (uniqueProfiles.size === 0) {
      info(diagnostics, "routes", "No agent model routes are required");
      return [];
    }
    if (!options.executorDescriptor) throw new Error("An exact agent executor descriptor is required to validate agent tool authority");
    const routeRegistry = options.routeRegistry ?? new AgentRouteRegistry();
    if (!options.routeRegistry) await routeRegistry.refresh({ defaults: options.routeDefaults });
    const routeSnapshot = routeRegistry.snapshot([...uniqueProfiles.keys()], options.availableModels ?? []);
    const routes = new Map(routeSnapshot.routes.map((route) => [route.profileId, route]));
    for (const selection of resolvedSelections) {
      resolveAgentTools(snapshotAgentProfile(selection.profile), {
        workspace: selection.workspace,
        network: selection.network,
      }, options.executorDescriptor);
    }
    info(diagnostics, "routes", `Resolved ${routeSnapshot.routes.length} exact profile routes`);
    info(diagnostics, "resources", "Static profile and tool authority is available; no effects were launched");

    const bySelector = new Map<string, WorkflowDraftResolvedProfile>();
    for (const selection of resolvedSelections) {
      const route = routes.get(selection.profile.id);
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
    return [...bySelector.values()].sort((left, right) => left.selector.localeCompare(right.selector));
  } catch (error) {
    const stage = /route|model/i.test(errorMessage(error)) ? "routes" : "profiles";
    diagnosticError(diagnostics, stage, error);
    return [];
  }
}

function operationAnalysis(parsed: ParsedStructuredWorkflow): WorkflowDraftOperationAnalysis {
  const byMethod: Record<string, number> = {};
  for (const operation of parsed.operationLocations) byMethod[operation.method] = (byMethod[operation.method] ?? 0) + 1;
  return {
    staticSites: parsed.operationLocations.length,
    byMethod: Object.fromEntries(Object.entries(byMethod).sort(([left], [right]) => left.localeCompare(right))),
    dynamicSites: {
      loops: byMethod.loop ?? 0,
      parallel: byMethod.parallel ?? 0,
      fanOut: byMethod.fanOut ?? 0,
    },
    hostAdmissionLimit: DEFINITION_LIMITS.semanticOperations,
  };
}

function emptyOperationAnalysis(): WorkflowDraftOperationAnalysis {
  return {
    staticSites: 0,
    byMethod: {},
    dynamicSites: { loops: 0, parallel: 0, fanOut: 0 },
    hostAdmissionLimit: DEFINITION_LIMITS.semanticOperations,
  };
}

async function readInstalled(
  filePath: string,
  diagnostics: WorkflowDraftDiagnostic[],
): Promise<{ source: string; hash: string } | undefined> {
  try {
    const source = await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(source)) {
      throw new Error(`Installed workflow ${filePath} contains disallowed control characters`);
    }
    return { source, hash: sha256(source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|no such file/i.test(errorMessage(error))) return undefined;
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
  if (installed === draft) {
    return { installedSourceHash: installedHash, draftSourceHash: draftHash, changed: false, preview: "", truncated: false };
  }
  const before = installed?.replace(/\r\n?/g, "\n").split("\n") ?? [];
  const after = draft.replace(/\r\n?/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const lines = [
    `--- ${installed ? "installed" : "/dev/null"}`,
    "+++ draft",
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const bounded = truncateUtf8(lines.join("\n"), DEFINITION_LIMITS.draftDiffBytes);
  return {
    installedSourceHash: installedHash,
    draftSourceHash: draftHash,
    changed: true,
    preview: bounded.text,
    truncated: bounded.truncated,
  };
}

function boundedUnique(
  values: readonly string[],
  label: string,
  diagnostics: WorkflowDraftDiagnostic[],
): string[] {
  const unique = [...new Set(values)].sort();
  const maximum = DEFINITION_LIMITS.profileFilesPerNamespace * 3;
  if (unique.length > maximum) {
    diagnosticError(diagnostics, "profiles", new Error(`Workflow names too many ${label} (${unique.length}/${maximum})`));
    return unique.slice(0, maximum);
  }
  return unique;
}

function info(diagnostics: WorkflowDraftDiagnostic[], stage: WorkflowDraftDiagnostic["stage"], message: string): void {
  pushDiagnostic(diagnostics, { stage, severity: "info", message });
}

function diagnosticError(
  diagnostics: WorkflowDraftDiagnostic[],
  stage: WorkflowDraftDiagnostic["stage"],
  error: unknown,
): void {
  const location = error instanceof WorkflowScriptError && error.location &&
    typeof error.location.line === "number" && typeof error.location.column === "number"
    ? { line: error.location.line, column: error.location.column }
    : undefined;
  pushDiagnostic(diagnostics, {
    stage,
    severity: "error",
    message: errorMessage(error),
    ...(location ? { location } : {}),
  });
}

function pushDiagnostic(diagnostics: WorkflowDraftDiagnostic[], diagnostic: WorkflowDraftDiagnostic): void {
  if (diagnostics.length >= DEFINITION_LIMITS.draftDiagnostics) return;
  diagnostics.push({ ...diagnostic, message: truncateUtf8(diagnostic.message, 2_048).text });
}

function truncateUtf8(value: string, maximum: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maximum) return { text: value, truncated: false };
  const suffix = "\n[…truncated…]";
  const capacity = maximum - Buffer.byteLength(suffix);
  let bytes = 0;
  let result = "";
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > capacity) break;
    result += scalar;
    bytes += size;
  }
  return { text: `${result}${suffix}`, truncated: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
