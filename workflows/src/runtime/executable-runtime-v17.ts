import { Ajv } from "ajv";
import { canonicalJsonObject } from "../definition/canonical-json.js";
import type { ParsedWorkflowV17, WorkflowV17Descriptor } from "../definition/workflow-v17-types.js";
import type { WorkflowV17CausalReplay } from "./causal-replay-v17.js";
import { WorkflowV17ControlAuthorityRegistry } from "./control-authority-v17.js";
import {
  evaluateWorkflowV17Control,
  type WorkflowV17HostFlow,
} from "./control-worker-host-v17.js";
import {
  WorkflowV17SemanticEngine,
  type WorkflowV17SemanticEngineFaultPoint,
  type WorkflowV17SemanticRunOutcome,
  type WorkflowV17SequentialFlow,
} from "./semantic-engine-v17.js";
import {
  WorkflowRunDatabaseV17,
  workflowV17InvocationIdentityHash,
} from "../persistence/run-database-v17.js";
import type { WorkflowV17InvocationSnapshot } from "../persistence/workflow-v17-invocation.js";
import type { JsonSchema, JsonValue } from "../types.js";
import type { HostCommandExecutor } from "../commands/executor.js";
import type { MeasurementEnvironmentProvider } from "../measurements/environment.js";
import { WorkflowV17MetricSetRuntime } from "../measurements/metric-set-v17.js";
import {
  WorkflowV17ExperimentEffectAdapter,
  WorkflowV17MeasurementEffectAdapter,
  type WorkflowV17MeasurementLaunchWorkspace,
} from "../measurements/adapter-v17.js";
import { WorkflowV17EffectProductFactory } from "../artifacts/products-v17.js";
import { workflowV17ArtifactManifest } from "../artifacts/manifest-v17.js";
import { WorkflowV17CandidateRuntime } from "../candidates/runtime-v17.js";
import {
  WorkflowV17AcceptEffectAdapter,
  WorkflowV17AgentEffectAdapter,
  WorkflowV17ApplyEffectAdapter,
  WorkflowV17AskEffectAdapter,
  WorkflowV17CommandEffectAdapter,
  WorkflowV17RejectEffectAdapter,
  WorkflowV17VerificationEffectAdapter,
  assertWorkflowV17StaticEffectResources,
  type WorkflowV17AgentEffectExecutor,
  type WorkflowV17ApplyExecutor,
  type WorkflowV17AskExecutor,
  type WorkflowV17CommandEffectExecutor,
  type WorkflowV17MeasurementAuthorityResolver,
  type WorkflowV17StaticEffectResources,
  type WorkflowV17VerificationExecutor,
} from "./effect-adapters-v17.js";

export interface WorkflowV17ExecutableRuntimeOptions {
  workflow: ParsedWorkflowV17;
  invocation: WorkflowV17InvocationSnapshot;
  database: WorkflowRunDatabaseV17;
  authority: WorkflowV17ControlAuthorityRegistry;
  products: WorkflowV17EffectProductFactory;
  candidates: WorkflowV17CandidateRuntime;
  resources: WorkflowV17StaticEffectResources;
  agent?: WorkflowV17AgentEffectExecutor;
  command?: WorkflowV17CommandEffectExecutor;
  ask?: WorkflowV17AskExecutor;
  verification?: WorkflowV17VerificationExecutor;
  apply?: WorkflowV17ApplyExecutor;
  measurements?: WorkflowV17MeasurementAuthorityResolver;
  metrics?: WorkflowV17MetricSetRuntime;
  measurement?: {
    executor: HostCommandExecutor;
    environment: MeasurementEnvironmentProvider;
    launchWorkspace: WorkflowV17MeasurementLaunchWorkspace;
  };
  replay?: WorkflowV17CausalReplay;
  signal?: AbortSignal;
  operationAdmissionLimit?: number;
  segmentTimeoutMs?: number;
  now?: () => Date;
  faultInjector?: (
    point: WorkflowV17SemanticEngineFaultPoint,
    operation?: import("../persistence/run-database-v17-types.js").WorkflowOperationV17Record,
  ) => void | Promise<void>;
}

/** Connect the reviewed control process to the cursor engine and v17 effect adapters. */
export class WorkflowV17ExecutableRuntime {
  constructor(private readonly options: WorkflowV17ExecutableRuntimeOptions) {
    assertWorkflowV17StaticEffectResources(options.workflow, options.resources);
    if (options.database.readRun().workflow.sourceHash !== options.workflow.sourceHash
      || options.database.readRun().workflow.definitionHash !== options.resources.definitionHash
      || options.database.readRun().invocationHash !== workflowV17InvocationIdentityHash(options.invocation)
      || options.invocation.sourceHash !== options.workflow.sourceHash
      || options.invocation.definitionHash !== options.resources.definitionHash
      || options.database.readRun().staticResourcesHash !== options.resources.hash
      || options.products.authority !== options.authority
      || options.candidates.authority !== options.authority) {
      throw new Error("Workflow v17 executable runtime authority differs from its run");
    }
    if (options.metrics && (options.metrics.database !== options.database
      || options.metrics.products !== options.products || options.metrics.workflow !== options.workflow)) {
      throw new Error("Workflow v17 metric runtime authority differs from its executable runtime");
    }
    this.requireExecutors();
  }

  async run(): Promise<WorkflowV17SemanticRunOutcome> {
    this.options.metrics?.beginExecution();
    const adapters = this.adapters();
    const engine = new WorkflowV17SemanticEngine(this.options.database, adapters, {
      candidate: this.options.candidates,
      ...(this.options.replay ? { replay: this.options.replay } : {}),
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      ...(this.options.operationAdmissionLimit !== undefined
        ? { operationAdmissionLimit: this.options.operationAdmissionLimit } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.faultInjector ? { faultInjector: this.options.faultInjector } : {}),
    });
    const outcome = await engine.run(async semantic => {
      const result = await evaluateWorkflowV17Control({
        workflow: this.options.workflow,
        flow: this.hostFlow(semantic),
        args: this.options.invocation.input,
        snapshot: this.options.candidates.snapshot,
        authority: this.options.authority,
        signal: this.options.signal ?? new AbortController().signal,
        rootContext: engine.currentControlContext(),
        currentContext: () => engine.currentControlContext(),
        runInContext: (context, body) => engine.runInControlContext(context, body),
        ...(this.options.metrics ? {
          metricCall: (metricSet, method, args) => this.options.metrics!.call(metricSet, method, args),
        } : {}),
        ...(this.options.segmentTimeoutMs !== undefined ? { segmentTimeoutMs: this.options.segmentTimeoutMs } : {}),
      });
      validateSchema(this.options.workflow.metadata.output, result, "workflow output");
      return result as JsonValue;
    });
    return outcome;
  }

  private hostFlow(semantic: WorkflowV17SequentialFlow): WorkflowV17HostFlow {
    return {
      parallel: async (sourceSite, branchesValue, optionsValue) => {
        const branches = callbackRecord(branchesValue, "parallel branches");
        const options = structuredOptions(optionsValue);
        return await semantic.parallel(
          Object.fromEntries(Object.entries(branches).map(([key, body]) => [
            key,
            async () => await body() as JsonValue,
          ])),
          { sourceSite, ...options },
        );
      },
      map: async (sourceSite, itemsValue, bodyValue, optionsValue) => {
        if (!Array.isArray(itemsValue) || typeof bodyValue !== "function") {
          throw new TypeError("Workflow v17 map arguments are invalid");
        }
        const options = plainRecord(optionsValue, "workflow v17 map options");
        if (typeof options.key !== "function") throw new TypeError("Workflow v17 map key must be a callback");
        return await semantic.map(
          itemsValue as JsonValue[],
          async (item, index) => await (bodyValue as (item: JsonValue, index: number) => Promise<JsonValue>)(item, index),
          {
            sourceSite,
            key: async (item, index) => await (options.key as (item: JsonValue, index: number) => Promise<string>)(item, index),
            ...structuredOptions(options),
          },
        );
      },
      agent: async (sourceSite, task, invocationValue) => {
        const descriptor = this.descriptor(task, sourceSite, "agent-task");
        const invocation = plainRecord(invocationValue, "workflow v17 agent invocation");
        const manifest = workflowV17ArtifactManifest(this.options.products, invocation.artifacts ?? {});
        const workspace = invocation.workspace;
        const workspaceIds = workspace ? [this.options.candidates.workspace(workspace).workspaceId] : [];
        return await semantic.effect("agent", {
          sourceSite,
          descriptorSourceSite: descriptor.identity.sourceSite,
          ...(typeof invocation.title === "string" ? { title: invocation.title } : {}),
          candidateWorkspaceIds: workspaceIds,
          input: {
            descriptorSourceSite: descriptor.identity.sourceSite,
            prompt: invocation.prompt,
            artifacts: manifest,
            ...(workspace ? { workspace } : {}),
          },
        });
      },
      command: async (sourceSite, task, invocationValue) => {
        const descriptor = this.descriptor(task, sourceSite, "command-task");
        const invocation = invocationValue === undefined
          ? {} : plainRecord(invocationValue, "workflow v17 command invocation");
        const workspace = invocation.workspace;
        const workspaceIds = workspace ? [this.options.candidates.workspace(workspace).workspaceId] : [];
        return await semantic.effect("command", {
          sourceSite,
          descriptorSourceSite: descriptor.identity.sourceSite,
          ...(typeof invocation.title === "string" ? { title: invocation.title } : {}),
          candidateWorkspaceIds: workspaceIds,
          input: {
            descriptorSourceSite: descriptor.identity.sourceSite,
            args: invocation.args ?? {},
            ...(workspace ? { workspace } : {}),
          },
        });
      },
      ask: async (sourceSite, requestValue) => {
        const request = plainRecord(requestValue, "workflow v17 ask request");
        return await semantic.effect("ask", {
          sourceSite,
          ...(typeof request.title === "string" ? { title: request.title } : {}),
          input: {
            prompt: request.prompt,
            responseSchema: canonicalJsonObject(request.response, schemaLimits()),
            ...(request.title !== undefined ? { title: request.title } : {}),
          },
        });
      },
      metrics: (sourceSite, policy, sampling) => {
        if (!this.options.metrics) throw new Error("Workflow v17 metric runtime is unavailable");
        return this.options.metrics.create(sourceSite, policy, sampling);
      },
      measure: async (sourceSite, profile, metrics, optionsValue) => {
        const options = optionsValue === undefined
          ? {} : plainRecord(optionsValue, "workflow v17 measurement options");
        return await semantic.effect("measure", {
          sourceSite,
          ...(typeof options.title === "string" ? { title: options.title } : {}),
          input: {
            operationSite: sourceSite,
            profile,
            metrics,
            ...(options.candidate ? { candidate: options.candidate } : {}),
          },
        });
      },
      candidate: async (sourceSite, bodyValue, optionsValue) => {
        if (typeof bodyValue !== "function") throw new TypeError("Workflow v17 candidate body must be a callback");
        const options = optionsValue === undefined
          ? {} : plainRecord(optionsValue, "workflow v17 candidate options");
        return await semantic.candidate({
          sourceSite,
          ...(typeof options.title === "string" ? { title: options.title } : {}),
          body: async workspace => await (bodyValue as (workspace: unknown) => Promise<JsonValue>)(workspace),
          input: { base: options.base, writes: options.writes },
        });
      },
      verify: async (sourceSite, candidate, profile) => await semantic.effect("verify", {
        sourceSite,
        input: { candidate, profile },
      }),
      accept: async (sourceSite, candidate, evidenceValue) => {
        const evidence = plainRecord(evidenceValue, "workflow v17 acceptance evidence");
        return await semantic.effect("accept", {
          sourceSite,
          input: {
            candidate,
            verification: evidence.verification,
            ...(evidence.measurement ? { measurement: evidence.measurement } : {}),
          },
        });
      },
      reject: async (sourceSite, candidate, evidenceValue) => {
        const evidence = plainRecord(evidenceValue, "workflow v17 rejection evidence");
        return await semantic.effect("reject", {
          sourceSite,
          input: {
            candidate,
            reason: evidence.reason,
            ...(evidence.verification ? { verification: evidence.verification } : {}),
            ...(evidence.measurement ? { measurement: evidence.measurement } : {}),
          },
        });
      },
      recordExperiment: async (sourceSite, requestValue) => {
        const request = plainRecord(requestValue, "workflow v17 experiment request");
        return await semantic.effect("record-experiment", {
          sourceSite,
          input: {
            candidate: request.candidate,
            measurement: request.measurement,
            learned: request.learned,
          },
        });
      },
      apply: async (sourceSite, candidate) => await semantic.effect("apply", {
        sourceSite,
        input: { candidate },
      }),
    };
  }

  private descriptor<K extends WorkflowV17Descriptor["kind"]>(
    value: unknown,
    operationSite: string,
    kind: K,
  ): Extract<WorkflowV17Descriptor, { kind: K }> {
    const description = this.options.authority.describe(value);
    const reviewed = this.options.workflow.operations.find(site => site.sourceSite === operationSite);
    const identity = description?.family === "descriptor"
      ? description.identity as import("../definition/workflow-language-v17.js").WorkflowV17DescriptorIdentity
      : undefined;
    if (!description || !identity || identity.kind !== kind
      || reviewed?.descriptorSourceSite !== identity.sourceSite) {
      throw new TypeError(`Workflow v17 flow.${kind === "agent-task" ? "agent" : "command"} descriptor authority is invalid`);
    }
    const descriptor = this.options.workflow.descriptors.find(
      entry => entry.identity.sourceSite === identity.sourceSite,
    );
    if (!descriptor || descriptor.kind !== kind
      || descriptor.identity.definitionHash !== identity.definitionHash) {
      throw new TypeError("Workflow v17 descriptor differs from static review");
    }
    return descriptor as Extract<WorkflowV17Descriptor, { kind: K }>;
  }

  private adapters() {
    const common = {
      database: this.options.database,
      products: this.options.products,
      candidates: this.options.candidates,
      workflow: this.options.workflow,
      resources: this.options.resources,
      ...(this.options.now ? { now: this.options.now } : {}),
    };
    return [
      ...(this.options.agent ? [new WorkflowV17AgentEffectAdapter({ ...common, executor: this.options.agent })] : []),
      ...(this.options.command ? [new WorkflowV17CommandEffectAdapter({ ...common, executor: this.options.command })] : []),
      ...(this.options.ask ? [new WorkflowV17AskEffectAdapter({ ...common, executor: this.options.ask })] : []),
      ...(this.options.verification
        ? [new WorkflowV17VerificationEffectAdapter({ ...common, executor: this.options.verification })] : []),
      ...(this.options.measurement && this.options.metrics ? [new WorkflowV17MeasurementEffectAdapter({
        ...common,
        invocation: this.options.invocation,
        metrics: this.options.metrics,
        executor: this.options.measurement.executor,
        environment: this.options.measurement.environment,
        launchWorkspace: this.options.measurement.launchWorkspace,
      })] : []),
      new WorkflowV17AcceptEffectAdapter({
        ...common,
        ...((this.options.metrics ?? this.options.measurements)
          ? { measurements: this.options.metrics ?? this.options.measurements } : {}),
      }),
      new WorkflowV17RejectEffectAdapter({
        ...common,
        ...((this.options.metrics ?? this.options.measurements)
          ? { measurements: this.options.metrics ?? this.options.measurements } : {}),
      }),
      ...(this.options.metrics ? [new WorkflowV17ExperimentEffectAdapter({
        database: this.options.database,
        products: this.options.products,
        candidates: this.options.candidates,
        metrics: this.options.metrics,
        ...(this.options.now ? { now: this.options.now } : {}),
      })] : []),
      ...(this.options.apply ? [new WorkflowV17ApplyEffectAdapter({ ...common, executor: this.options.apply })] : []),
    ];
  }

  private requireExecutors(): void {
    const methods = new Set(this.options.workflow.operations.map(site => site.method));
    for (const [method, available] of [
      ["agent", Boolean(this.options.agent)],
      ["command", Boolean(this.options.command)],
      ["ask", Boolean(this.options.ask)],
      ["verify", Boolean(this.options.verification)],
      ["apply", Boolean(this.options.apply)],
      ["metrics", Boolean(this.options.metrics)],
      ["measure", Boolean(this.options.measurement && this.options.metrics)],
      ["recordExperiment", Boolean(this.options.metrics)],
    ] as const) {
      if (methods.has(method) && !available) throw new Error(`Workflow v17 ${method} executor is unavailable`);
    }
  }
}

function callbackRecord(value: unknown, label: string): Record<string, () => Promise<unknown>> {
  const record = plainRecord(value, `workflow v17 ${label}`);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "function") throw new TypeError(`Workflow v17 ${label} ${key} is not a callback`);
  }
  return record as Record<string, () => Promise<unknown>>;
}

function structuredOptions(value: unknown): {
  concurrency?: number;
  errors?: "fail-fast" | "collect";
} {
  if (value === undefined) return {};
  const record = plainRecord(value, "workflow v17 structured options");
  const result: { concurrency?: number; errors?: "fail-fast" | "collect" } = {};
  if (record.concurrency !== undefined) {
    if (!Number.isSafeInteger(record.concurrency) || (record.concurrency as number) < 1) {
      throw new TypeError("Workflow v17 concurrency must be a positive integer");
    }
    result.concurrency = record.concurrency as number;
  }
  if (record.errors !== undefined) {
    if (record.errors !== "fail-fast" && record.errors !== "collect") {
      throw new TypeError("Workflow v17 structured errors policy is invalid");
    }
    result.errors = record.errors;
  }
  return result;
}

function validateSchema(schema: JsonSchema, value: unknown, label: string): void {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new TypeError(`Invalid workflow v17 ${label}: ${ajv.errorsText(validate.errors)}`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function schemaLimits() {
  return { maxBytes: 1024 * 1024, maxDepth: 48, maxNodes: 50_000, maxStringScalars: 100_000 };
}
