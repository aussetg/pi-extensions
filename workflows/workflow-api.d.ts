/** Ambient authoring declarations for reviewed `.flow.js` definitions. */
export {};

declare global {
  type FlowJsonPrimitive = null | boolean | number | string;
  type FlowJsonValue = FlowJsonPrimitive | FlowJsonValue[] | { [key: string]: FlowJsonValue };
  type FlowJsonObject = { [key: string]: FlowJsonValue };
  type FlowJsonSchema = Record<string, unknown>;
  /** Registered semantic/profile selector. Source validation requires a literal. */
  type FlowProfileSelector = string;
  type FlowCapability =
    | "read-project"
    | "candidate-write"
    | "host-command"
    | "mediated-network"
    | "human-input";

  interface FlowWorkflowDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: FlowJsonSchema;
    outputSchema: FlowJsonSchema;
    capabilities: FlowCapability[];
    modelVisible: boolean;
    /** May only lower the host-owned concurrency ceiling. */
    maxParallelism?: number;
    run(flow: FlowApi, args: any): Promise<any>;
  }

  function defineWorkflow(definition: FlowWorkflowDefinition): Readonly<FlowWorkflowDefinition>;

  interface FlowConditionResult {
    result: boolean;
    label: string;
    operands?: FlowJsonObject;
  }

  interface FlowBranchFailure {
    operationPath: string;
    kind: "agent" | "command" | "output" | "control" | "infrastructure";
    summary: string;
    evidence?: FlowArtifactRef[];
  }

  type FlowBranchResult<T> = { ok: true; value: T } | { ok: false; failure: FlowBranchFailure };

  interface FlowParallelOptions {
    title?: string;
    /** A lower request only; the host always enforces its machine ceiling. */
    concurrency?: number;
    failure?: "fail-fast";
  }

  interface FlowCollectParallelOptions {
    title?: string;
    concurrency?: number;
    failure: "collect";
  }

  interface FlowAgentArtifactInput {
    id: string;
    artifact: FlowArtifactRef;
  }

  interface FlowAgentProduct<T extends FlowJsonValue> {
    value: T;
    artifact: FlowArtifactRef<"agent-output">;
    /** Present for candidate agents after the host commits their exact post-workspace checkpoint. */
    workspaceCheckpointArtifact?: FlowArtifactRef<"workspace-checkpoint">;
  }

  interface FlowAgentOptions {
    title?: string;
    profile: FlowProfileSelector;
    prompt: string;
    inputs?: FlowAgentArtifactInput[];
    outputSchema?: FlowJsonSchema;
    workspace?: FlowCandidateWorkspace;
    network?: "none" | "research";
    resultMode?: "value" | "artifact" | "value-and-artifact";
  }

  interface FlowCommandResult {
    ok: boolean;
    exitCode: number;
    durationMs: number;
    stdout?: string;
    json?: FlowJsonValue;
    stderrPreview?: string;
    outputArtifact?: FlowArtifactRef<"command-output">;
  }

  interface FlowCommandBaseOptions {
    title?: string;
    profile: FlowProfileSelector;
    /** Bounded scalar values declared by the reviewed command profile. */
    args?: Record<string, string | number | boolean>;
    output?: "summary" | "stdout" | "json";
    allowFailure?: boolean;
  }

  type FlowCommandOptions =
    | (FlowCommandBaseOptions & {
        effect?: "read-only" | "temporary";
        workspace?: never;
      })
    | (FlowCommandBaseOptions & {
        effect: "candidate";
        workspace: FlowCandidateWorkspace;
      });

  interface FlowMetricDefinition {
    title?: string;
    direction: "minimize" | "maximize";
    unit?: string;
    primary?: boolean;
    format?: "number" | "percent" | "duration" | "bytes";
    target?:
      | { kind: "value"; value: number }
      | { kind: "relativeGain"; value: number }
      | { kind: "absoluteGain"; value: number };
    sampling?: { warmups?: number; samples: number; aggregate: "median" | "mean" | "min" | "max" };
    improvement?: { minimumAbsolute?: number; minimumRelative?: number };
    guardrail?: {
      reference: "baseline" | "best";
      maximumAbsoluteRegression?: number;
      maximumRelativeRegression?: number;
    };
  }

  interface FlowMetricObservation {
    observationId: string;
    metricId: string;
    outputId: string;
    value: number;
    samples: number[];
  }

  interface FlowMeasurementEvidence {
    measurementId: string;
    profile: string;
    profileHash: string;
    environmentHash: string;
    diagnostics: Array<{ sample: number; data: FlowJsonObject }>;
    diagnosticsArtifact?: FlowArtifactRef<"measurement-diagnostics">;
  }

  interface FlowMeasurementResult extends FlowMeasurementEvidence {
    observation: FlowMetricObservation;
  }

  interface FlowMeasurementSetResult extends FlowMeasurementEvidence {
    observations: Record<string, FlowMetricObservation>;
  }

  interface FlowMetricSummary {
    baseline: number | null;
    current: number | null;
    best: number | null;
    relativeGain: number | null;
    observationCount: number;
  }

  interface FlowMetricHandle {
    readonly baseline: number | null;
    readonly current: number | null;
    readonly best: number | null;
    readonly relativeGain: number | null;
    reachesTarget(): FlowConditionResult;
    needsImprovement(): FlowConditionResult;
    isImprovement(result: FlowMetricObservation): boolean;
    isWithinGuardrail(result: FlowMetricObservation): boolean;
    summary(): FlowMetricSummary;
  }

  const __flowOpaque: unique symbol;
  type FlowOpaqueRef<K extends string> = Readonly<{ readonly [__flowOpaque]: K }>;
  type FlowArtifactKind = "agent-output" | "command-output" | "measurement-diagnostics" | "published" | "workspace-checkpoint";
  type FlowArtifactRef<K extends FlowArtifactKind = FlowArtifactKind> = FlowOpaqueRef<`artifact-${K}`>;
  type FlowCandidateRef = FlowOpaqueRef<"immutable-candidate" | "accepted-candidate">;
  type FlowAcceptedCandidateRef = FlowOpaqueRef<"accepted-candidate">;
  type FlowCandidateWorkspace = FlowOpaqueRef<"mutable-candidate-workspace">;
  type FlowLaunchSnapshotRef = FlowOpaqueRef<"launch-snapshot">;
  type FlowCandidateMeasurement = FlowMeasurementResult | FlowMeasurementSetResult;

  interface FlowProducedCandidate<T extends FlowJsonValue> {
    candidate: FlowCandidateRef;
    metadata: T;
    /** Exact changed paths from the frozen candidate, not an agent claim. */
    changedPaths: string[];
  }

  interface FlowRejectionReceipt {
    receiptId: string;
    candidateId: string;
    changedPaths: string[];
    reason: string;
    measurementId?: string;
    verificationReceiptId?: string;
  }

  interface FlowApplyReceipt {
    applied: true;
    receiptId: string;
    candidateId: string;
    changedPaths: string[];
  }

  interface FlowVerificationReceiptEvidence {
    receiptId: string;
    candidateId: string;
    candidateLineageHash: string;
    candidateTreeHash: string;
    candidateWriteScopeHash: string;
    profileHash: string;
    policyHash: string;
    gateEvidenceHashes: string[];
    environmentHash: string;
  }

  interface FlowPassedVerificationReceipt extends FlowVerificationReceiptEvidence {
    passed: true;
    status: "passed";
  }

  interface FlowNonPassedVerificationReceipt extends FlowVerificationReceiptEvidence {
    passed: false;
    status: "failed" | "blocked";
  }

  type FlowVerificationReceipt = FlowPassedVerificationReceipt | FlowNonPassedVerificationReceipt;

  interface FlowExperimentMetadata extends FlowJsonObject {
    hypothesis: string;
    changeSummary: string;
    expectedEffect: string;
    nextFocus: string;
  }

  interface FlowExperimentSummary {
    experimentId: string;
    candidateId: string;
    iteration?: number;
    disposition: "accepted" | "rejected";
    hypothesis: string;
    primary?: { metricId: string; value: number; relativeChange: number | null };
    guardrails: Array<{ metricId: string; value: number; passed: boolean }>;
    diagnostics: Array<{ sample: number; data: FlowJsonObject }>;
    learned: string;
    nextFocus: string;
  }

  interface FlowApi {
    readonly snapshot: FlowLaunchSnapshotRef;

    stage<T>(id: string, body: () => Promise<T>, options?: { title?: string }): Promise<T>;
    loop<T>(
      id: string,
      options:
        | { title?: string; maxIterations: number; while: () => FlowConditionResult; until?: never }
        | { title?: string; maxIterations: number; while?: never; until: () => FlowConditionResult },
      body: (context: { iteration: number }) => Promise<T>,
    ): Promise<{ iterations: number; last?: T; stoppedBy: "condition" | "limit" }>;
    parallel<T>(
      id: string,
      branches: Record<string, () => Promise<T>>,
      options?: FlowParallelOptions,
    ): Promise<Record<string, T>>;
    parallel<T>(
      id: string,
      branches: Record<string, () => Promise<T>>,
      options: FlowCollectParallelOptions,
    ): Promise<Record<string, FlowBranchResult<T>>>;
    fanOut<TItem, TResult>(
      id: string,
      items: readonly TItem[],
      options: {
        key: (item: TItem, index: number) => string;
        title?: string;
        concurrency?: number;
        failure?: "fail-fast";
      },
      body: (item: TItem, context: { key: string; index: number }) => Promise<TResult>,
    ): Promise<TResult[]>;
    fanOut<TItem, TResult>(
      id: string,
      items: readonly TItem[],
      options: {
        key: (item: TItem, index: number) => string;
        title?: string;
        concurrency?: number;
        failure: "collect";
      },
      body: (item: TItem, context: { key: string; index: number }) => Promise<TResult>,
    ): Promise<Array<FlowBranchResult<TResult>>>;

    agent<T extends FlowJsonValue = FlowJsonValue>(
      id: string,
      options: FlowAgentOptions & { resultMode?: "value" },
    ): Promise<T>;
    agent(id: string, options: FlowAgentOptions & { resultMode: "artifact" }): Promise<FlowArtifactRef<"agent-output">>;
    agent<T extends FlowJsonValue = FlowJsonValue>(
      id: string,
      options: FlowAgentOptions & { resultMode: "value-and-artifact" },
    ): Promise<FlowAgentProduct<T>>;
    command(id: string, options: FlowCommandOptions): Promise<FlowCommandResult>;
    checkpoint(id: string, options: { kind: "confirm"; title?: string; prompt: string }): Promise<boolean>;
    checkpoint(
      id: string,
      options: { kind: "choice"; title?: string; prompt: string; choices: Array<{ id: string; label: string }> },
    ): Promise<string>;
    checkpoint<T extends FlowJsonValue>(
      id: string,
      options: { kind: "input"; title?: string; prompt: string; responseSchema: FlowJsonSchema },
    ): Promise<T>;
    metric(id: string, definition: FlowMetricDefinition): FlowMetricHandle;
    measure(
      id: string,
      options: { title?: string; metric: FlowMetricHandle; measurement: FlowProfileSelector; output?: string; workspace?: FlowCandidateRef },
    ): Promise<FlowMeasurementResult>;
    measure(
      id: string,
      options: { title?: string; metrics: Record<string, FlowMetricHandle>; measurement: FlowProfileSelector; workspace?: FlowCandidateRef },
    ): Promise<FlowMeasurementSetResult>;
    candidate<T extends FlowJsonValue>(
      id: string,
      body: (workspace: FlowCandidateWorkspace) => Promise<T>,
      options?: {
        title?: string;
        base?: FlowLaunchSnapshotRef | FlowAcceptedCandidateRef;
        metadataSchema?: FlowJsonSchema;
        writes?: { allow: string[]; deny?: string[] };
      },
    ): Promise<FlowProducedCandidate<T>>;
    verify(
      id: string,
      options: { title?: string; candidate: FlowCandidateRef; profile: FlowProfileSelector },
    ): Promise<FlowVerificationReceipt>;
    accept(
      id: string,
      options: {
        candidate: FlowCandidateRef;
        verification: FlowPassedVerificationReceipt;
        measurement?: FlowCandidateMeasurement;
      },
    ): Promise<FlowAcceptedCandidateRef>;
    reject(
      id: string,
      options: {
        candidate: FlowCandidateRef;
        reason: string;
        measurement?: FlowCandidateMeasurement;
        verification?: FlowVerificationReceipt;
      },
    ): Promise<FlowRejectionReceipt>;
    recordExperiment(
      id: string,
      options: {
        candidate: FlowProducedCandidate<FlowExperimentMetadata>;
        measurement: FlowCandidateMeasurement;
        learned: string;
      },
    ): Promise<FlowExperimentSummary>;
    apply(
      id: string,
      /** Every apply site enters an exact human approval checkpoint. */
      options: {
        candidate: FlowAcceptedCandidateRef;
        verification: FlowPassedVerificationReceipt;
      },
    ): Promise<FlowApplyReceipt>;
  }
}
