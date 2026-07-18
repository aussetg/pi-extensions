/** Public authoring contract for workflow runtime `.flow.ts` modules. */
declare module "pi/workflows" {
  export type JsonPrimitive = null | boolean | number | string;
  export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
  export type JsonObject = { readonly [key: string]: JsonValue };

  const schemaValue: unique symbol;
  const optionalValue: unique symbol;
  const opaqueValue: unique symbol;
  const attachableValue: unique symbol;
  const taskValue: unique symbol;

  export interface Schema<T> {
    readonly [schemaValue]: T;
  }

  export interface OptionalSchema<T> extends Schema<T | undefined> {
    readonly [optionalValue]: true;
  }

  export type Infer<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;

  type Properties = Readonly<Record<string, Schema<unknown>>>;
  type OptionalKeys<P extends Properties> = {
    [K in keyof P]-?: P[K] extends OptionalSchema<unknown> ? K : never;
  }[keyof P];
  type RequiredKeys<P extends Properties> = Exclude<keyof P, OptionalKeys<P>>;
  type ObjectType<P extends Properties> = {
    readonly [K in RequiredKeys<P>]: Infer<P[K]>;
  } & {
    readonly [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined>;
  };

  export interface StringOptions {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
  }

  export interface NumberOptions {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
  }

  export interface ArrayOptions {
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
  }

  export type MeasurementProfileSelector = string & {
    readonly [opaqueValue]: "measurement-profile-selector";
  };

  export const schema: {
    string(options?: StringOptions): Schema<string>;
    number(options?: NumberOptions): Schema<number>;
    integer(options?: NumberOptions): Schema<number>;
    boolean(): Schema<boolean>;
    literal<const T extends JsonPrimitive>(value: T): Schema<T>;
    enum<const T extends readonly string[]>(values: T): Schema<T[number]>;
    nullable<S extends Schema<unknown>>(value: S): Schema<Infer<S> | null>;
    optional<S extends Schema<unknown>>(value: S): OptionalSchema<Infer<S>>;
    array<S extends Schema<unknown>>(items: S, options?: ArrayOptions): Schema<ReadonlyArray<Infer<S>>>;
    object<const P extends Properties>(properties: P): Schema<ObjectType<P>>;
    union<const S extends readonly Schema<unknown>[]>(members: S): Schema<Infer<S[number]>>;
    record<S extends Schema<unknown>>(values: S): Schema<Record<string, Infer<S>>>;
    id(): Schema<string>;
    safePath(): Schema<string>;
    json(): Schema<JsonValue>;
    measurementProfile(): Schema<MeasurementProfileSelector>;
    raw<T extends JsonValue = JsonValue>(schema: Readonly<Record<string, JsonValue>>): Schema<T>;
  };

  export type ProfileSelector = `${"builtin" | "user" | "project"}:${string}`;
  export type WorkspaceClass = "snapshot" | "candidate";

  interface TaskDescriptor {
    readonly [taskValue]: unknown;
  }

  export interface AgentTask<
    Output extends JsonObject,
    Workspace extends WorkspaceClass,
  > extends TaskDescriptor {
    readonly [taskValue]: {
      readonly kind: "agent";
      readonly output: Output;
      readonly workspace: Workspace;
    };
  }

  export function agent<
    S extends Schema<JsonObject>,
    W extends WorkspaceClass = "snapshot",
  >(definition: {
    profile: ProfileSelector;
    output: S;
    workspace?: W;
    network?: "none" | "research";
    instructions?: string;
    title?: string;
  }): AgentTask<Infer<S>, W>;

  export type CommandMode = "summary" | "text" | "json";
  export type CommandEffect = "read-only" | "temporary" | "candidate";

  export interface CommandTask<
    Mode extends CommandMode,
    Effect extends CommandEffect,
  > extends TaskDescriptor {
    readonly [taskValue]: {
      readonly kind: "command";
      readonly mode: Mode;
      readonly effect: Effect;
    };
  }

  export function command<
    M extends CommandMode = "summary",
    E extends CommandEffect = "read-only",
  >(definition: {
    profile: ProfileSelector;
    output?: M;
    effect?: E;
    allowFailure?: boolean;
    title?: string;
  }): CommandTask<M, E>;

  export interface Artifact<T extends JsonValue = JsonValue> {
    readonly [opaqueValue]: "artifact";
    readonly [attachableValue]: true;
  }

  export interface WorkspaceCheckpoint extends Artifact<JsonObject> {
    readonly [opaqueValue]: "artifact";
  }

  interface AttachableProduct {
    readonly [attachableValue]: true;
  }

  export type AgentResult<
    Output extends JsonObject,
    Workspace extends WorkspaceClass,
  > = Readonly<{
    output: Output;
    artifact: Artifact<Output>;
    published: readonly Artifact[];
  } & (Workspace extends "candidate" ? { checkpoint: WorkspaceCheckpoint } : {})> & AttachableProduct;

  export interface CommandSummary extends JsonObject {
    ok: boolean;
    exitCode: number;
    durationMs: number;
  }

  export type CommandOutput<M extends CommandMode> =
    M extends "text" ? string
      : M extends "json" ? JsonValue
        : CommandSummary;

  export interface CommandResult<M extends CommandMode> extends AttachableProduct {
    readonly ok: boolean;
    readonly exitCode: number;
    readonly durationMs: number;
    readonly output: CommandOutput<M>;
    readonly artifact: Artifact;
    readonly stderrPreview?: string;
  }

  export type ArtifactInput =
    | Artifact
    | AttachableProduct
    | readonly ArtifactInput[]
    | { readonly [name: string]: ArtifactInput };

  export interface LaunchSnapshot {
    readonly [opaqueValue]: "launch-snapshot";
  }

  export interface CandidateWorkspace {
    readonly [opaqueValue]: "candidate-workspace";
  }

  export interface Candidate<T extends JsonValue> {
    readonly [opaqueValue]: "candidate-product";
    readonly output: T;
    readonly changedPaths: readonly string[];
  }

  export interface AcceptedCandidate<T extends JsonValue> {
    readonly [opaqueValue]: "accepted-candidate-product";
    readonly output: T;
    readonly changedPaths: readonly string[];
  }

  export interface BranchError {
    kind: "agent" | "command" | "output" | "control" | "infrastructure";
    summary: string;
    evidence: Artifact[];
  }

  export type Result<T, E> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E };

  interface VerificationProduct extends AttachableProduct {
    readonly [opaqueValue]: "verification-product";
    readonly receiptId: string;
    readonly artifact: Artifact;
  }

  export interface PassedVerification extends VerificationProduct {
    readonly passed: true;
    readonly status: "passed";
  }

  export interface NonPassedVerification extends VerificationProduct {
    readonly passed: false;
    readonly status: "failed" | "blocked";
  }

  export type Verification = PassedVerification | NonPassedVerification;

  export interface Observation extends JsonObject {
    observationId: string;
    metricId: string;
    outputId: string;
    value: number;
    samples: number[];
  }

  export interface MetricSummary extends JsonObject {
    baseline: number;
    current: number;
    best: number;
    relativeGain: number | null;
    observationCount: number;
  }

  export interface MetricTarget extends JsonObject {
    kind: "value" | "relativeGain" | "absoluteGain";
    value: number;
  }

  export interface MetricImprovement extends JsonObject {
    minimumAbsolute?: number;
    minimumRelative?: number;
  }

  export interface MetricBase extends JsonObject {
    output: string;
    title?: string;
    direction: "minimize" | "maximize";
    unit?: string;
    format?: "number" | "percent" | "duration" | "bytes";
    aggregate?: "median" | "mean" | "min" | "max";
  }

  export interface PrimaryMetricPolicy extends MetricBase {
    target?: MetricTarget;
    improvement?: MetricImprovement;
  }

  export interface GuardrailMetricPolicy extends MetricBase {
    reference: "baseline" | "best";
    maximumAbsoluteRegression?: number;
    maximumRelativeRegression?: number;
  }

  export interface ObservedMetricPolicy extends MetricBase {
  }

  export interface MetricPolicySet {
    primary: PrimaryMetricPolicy;
    guardrails?: readonly GuardrailMetricPolicy[];
    observe?: readonly ObservedMetricPolicy[];
  }

  export interface SamplingPolicy extends JsonObject {
    warmups: number;
    samples: number;
  }

  export interface MetricPolicyEvaluation extends JsonObject {
    acceptable: boolean;
    summary: string;
    violations: string[];
  }

  export interface MetricSet {
    readonly [opaqueValue]: "metric-set";
    readonly primary: {
      reachedTarget(): boolean;
    };
    policy(): MetricPolicySet;
    summary(): Record<string, MetricSummary>;
    evaluate(measurement: Measurement): MetricPolicyEvaluation;
  }

  export interface Measurement extends AttachableProduct {
    readonly measurementId: string;
    readonly observations: Record<string, Observation>;
    readonly diagnostics?: Artifact;
    readonly artifact: Artifact;
  }

  export interface Rejection extends JsonObject {
    receiptId: string;
    changedPaths: string[];
    reason: string;
  }

  export interface ApplyReceipt extends JsonObject {
    applied: true;
    receiptId: string;
    changedPaths: string[];
  }

  export interface ExperimentMetadata extends JsonObject {
    hypothesis: string;
    changeSummary: string;
    expectedEffect: string;
    nextFocus: string;
  }

  export interface ExperimentSummary extends JsonObject {
    experimentId: string;
    disposition: "accepted" | "rejected";
    learned: string;
  }

  export interface Flow {
    readonly snapshot: LaunchSnapshot;

    agent<T extends JsonObject>(
      task: AgentTask<T, "snapshot">,
      invocation: {
        prompt: string;
        artifacts?: Readonly<Record<string, ArtifactInput>>;
        title?: string;
      },
    ): Promise<AgentResult<T, "snapshot">>;

    agent<T extends JsonObject>(
      task: AgentTask<T, "candidate">,
      invocation: {
        workspace: CandidateWorkspace;
        prompt: string;
        artifacts?: Readonly<Record<string, ArtifactInput>>;
        title?: string;
      },
    ): Promise<AgentResult<T, "candidate">>;

    command<M extends CommandMode>(
      task: CommandTask<M, "read-only" | "temporary">,
      invocation?: { args?: Readonly<Record<string, string | number | boolean>>; title?: string },
    ): Promise<CommandResult<M>>;

    command<M extends CommandMode>(
      task: CommandTask<M, "candidate">,
      invocation: {
        workspace: CandidateWorkspace;
        args?: Readonly<Record<string, string | number | boolean>>;
        title?: string;
      },
    ): Promise<CommandResult<M>>;

    parallel<const B extends Readonly<Record<string, () => Promise<unknown>>>>(
      branches: B,
      options?: { concurrency?: number; errors?: "fail-fast" },
    ): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;

    parallel<const B extends Readonly<Record<string, () => Promise<unknown>>>>(
      branches: B,
      options: { concurrency?: number; errors: "collect" },
    ): Promise<{ [K in keyof B]: Result<Awaited<ReturnType<B[K]>>, BranchError> }>;

    map<Item, Output>(
      items: readonly Item[],
      body: (item: Item, index: number) => Promise<Output>,
      options: {
        key: (item: Item, index: number) => string;
        concurrency?: number;
        errors?: "fail-fast";
      },
    ): Promise<Output[]>;

    map<Item, Output>(
      items: readonly Item[],
      body: (item: Item, index: number) => Promise<Output>,
      options: {
        key: (item: Item, index: number) => string;
        concurrency?: number;
        errors: "collect";
      },
    ): Promise<Array<Result<Output, BranchError>>>;

    ask<S extends Schema<JsonValue>>(request: {
      prompt: string;
      response: S;
      title?: string;
    }): Promise<Infer<S>>;

    metrics(policy: MetricPolicySet, sampling?: SamplingPolicy): MetricSet;

    measure(
      profile: ProfileSelector | MeasurementProfileSelector,
      metrics: MetricSet,
      options?: { candidate?: Candidate<JsonValue>; title?: string },
    ): Promise<Measurement>;

    candidate<T extends JsonValue>(
      body: (workspace: CandidateWorkspace) => Promise<T>,
      options?: {
        base?: LaunchSnapshot | AcceptedCandidate<JsonValue>;
        writes?: readonly string[] | {
          allow: readonly string[];
          deny?: readonly string[];
        };
        title?: string;
      },
    ): Promise<Candidate<T>>;

    verify<T extends JsonValue>(
      candidate: Candidate<T>,
      profile: ProfileSelector,
    ): Promise<Verification>;

    accept<T extends JsonValue>(
      candidate: Candidate<T>,
      evidence: {
        verification: PassedVerification;
        measurement?: Measurement;
      },
    ): Promise<AcceptedCandidate<T>>;

    reject<T extends JsonValue>(
      candidate: Candidate<T>,
      evidence: {
        reason: string;
        verification?: Verification;
        measurement?: Measurement;
      },
    ): Promise<Rejection>;

    recordExperiment(request: {
      candidate: Candidate<ExperimentMetadata>;
      measurement: Measurement;
      learned: string;
    }): Promise<ExperimentSummary>;

    apply<T extends JsonValue>(candidate: AcceptedCandidate<T>): Promise<ApplyReceipt>;
  }

  export interface WorkflowDefinition<Input extends JsonObject, Output extends JsonValue> {
    readonly description: string;
    readonly title?: string;
    readonly input: Schema<Input>;
    readonly output: Schema<Output>;
    readonly concurrency?: number;
    readonly run: (flow: Flow, input: Readonly<Input>) => Promise<Output>;
  }

  export function workflow<
    I extends Schema<JsonObject>,
    O extends Schema<JsonValue>,
  >(definition: {
    description: string;
    title?: string;
    input: I;
    output: O;
    concurrency?: number;
    run(flow: Flow, input: Readonly<Infer<I>>): Promise<NoInfer<Infer<O>>>;
  }): WorkflowDefinition<Infer<I>, Infer<O>>;
}
