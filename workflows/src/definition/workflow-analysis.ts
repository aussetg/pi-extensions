import type { JsonSchema, JsonValue } from "../types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "./limits.js";
import {
  isFunction,
  location,
  memberPropertyName,
  objectProperties,
  sourceLocation,
  walk,
  type WorkflowAstNode,
} from "./workflow-ast.js";
import {
  collectWorkflowSchemaResources,
  isWorkflowMeasurementProfileSchema,
  isWorkflowSafePathSchema,
  workflowSchemaAtPath,
  type WorkflowSchemaEvaluator,
} from "./workflow-schema.js";
import type {
  WorkflowAgentDescriptor,
  WorkflowCandidateWriteSite,
  WorkflowCapability,
  WorkflowCommandDescriptor,
  WorkflowDescriptor,
  WorkflowDynamicResourceUse,
  WorkflowExecutionContext,
  WorkflowHelperSummary,
  WorkflowNativeLoop,
  WorkflowOperationSite,
  WorkflowReview,
} from "./workflow-types.js";

export const WORKFLOW_FLOW_METHODS = Object.freeze([
  "parallel",
  "map",
  "agent",
  "command",
  "ask",
  "metrics",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
] as const);

type FlowMethod = WorkflowOperationSite["method"];
type ContextBoundaryKind = "concurrent" | "candidate" | "key";

interface ContextBoundary {
  kind: ContextBoundaryKind;
  root: WorkflowAstNode;
}

type ContextSignature = readonly ContextBoundary[];

interface FunctionEdge {
  target: WorkflowAstNode;
  kind: "direct" | ContextBoundaryKind;
  node: WorkflowAstNode;
}

interface DirectEffect {
  node: WorkflowAstNode;
  method: string;
}

interface FunctionModel {
  functions: WorkflowAstNode[];
  parentFunction: Map<WorkflowAstNode, WorkflowAstNode | undefined>;
  functionBindings: Map<WorkflowAstNode | undefined, Map<string, WorkflowAstNode>>;
  declaredNames: Map<WorkflowAstNode, Set<string>>;
  parameterNames: Map<WorkflowAstNode, Set<string>>;
  names: Map<WorkflowAstNode, string>;
}

interface MetricBinding {
  name: string;
  owner: WorkflowAstNode;
  policyPath?: string;
  samplingPath?: string;
}

interface InternalOperationSite extends WorkflowOperationSite {
  node: WorkflowAstNode;
  owner: WorkflowAstNode;
}

export interface AnalyzeWorkflowSourceInput {
  ast: WorkflowAstNode;
  runNode: WorkflowAstNode;
  flowName: string;
  inputSchema: JsonSchema;
  maximumConcurrency?: number;
  inputPath(node: WorkflowAstNode): string | undefined;
  schemaEvaluator: WorkflowSchemaEvaluator;
  descriptors: readonly WorkflowDescriptor[];
  parents: Map<WorkflowAstNode, { parent: WorkflowAstNode; key: string }>;
}

export interface AnalyzeWorkflowSourceResult {
  operations: WorkflowOperationSite[];
  operationNodes: Array<{ sourceSite: string; node: WorkflowAstNode }>;
  helpers: WorkflowHelperSummary[];
  review: Omit<WorkflowReview, "maximumConcurrency">;
}

const FLOW_METHOD_SET = new Set<string>(WORKFLOW_FLOW_METHODS);
const PROFILE_SELECTOR = /^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/;
const CONCURRENT_FORBIDDEN = new Set<FlowMethod>(["ask", "apply"]);
const CANDIDATE_FORBIDDEN = new Set<FlowMethod>([
  "ask", "metrics", "measure", "candidate", "verify", "accept", "reject", "recordExperiment", "apply",
]);
const FORBIDDEN_IDENTIFIERS = new Set([
  "process", "require", "Buffer", "global", "globalThis", "fetch", "XMLHttpRequest", "WebSocket",
  "EventSource", "navigator", "performance", "crypto", "fs", "child_process", "http", "https", "net",
  "tls", "dns", "module", "exports", "__dirname", "__filename", "Deno", "Bun", "console",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "queueMicrotask", "Proxy", "Reflect", "WeakRef", "FinalizationRegistry", "SharedArrayBuffer", "Atomics",
  "ArrayBuffer", "DataView", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array",
  "Int16Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "WebAssembly", "Blob", "File", "structuredClone",
]);
const AMBIENT_TIME_IDENTIFIERS = new Set(["Date", "Intl", "Temporal"]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__"]);
const MUTATING_METHODS = new Set([
  "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift", "set", "add",
  "delete", "clear",
]);
const FRESH_CONTAINER_METHODS = new Set(["concat", "filter", "flat", "flatMap", "map", "slice", "toReversed", "toSorted", "toSpliced"]);
const CONTEXT_ORDER: WorkflowExecutionContext[] = ["root", "concurrent", "candidate", "key"];

export function analyzeWorkflowSource(
  input: AnalyzeWorkflowSourceInput,
): AnalyzeWorkflowSourceResult {
  const model = buildFunctionModel(input);
  const directEffects = new Map(model.functions.map((fn) => [fn, [] as DirectEffect[]]));
  const edges = new Map(model.functions.map((fn) => [fn, [] as FunctionEdge[]]));

  for (const fn of model.functions) {
    walkOwn(fn.body, (node) => {
      const method = flowMethod(node, input.flowName);
      if (method) {
        directEffects.get(fn)!.push({ node, method });
        markStructuredCallbacks(input, model, fn, node, method, edges);
      }
      if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
        const target = resolveFunctionBinding(model, fn, node.callee.name);
        if (target) edges.get(fn)!.push({ target, kind: "direct", node });
      }
    });
  }

  rejectRecursiveFunctionGraph(model, edges);
  const signatures = propagateContextSignatures(input.runNode, model.functions, edges);
  const effectful = effectfulFunctions(model.functions, directEffects, edges);
  rejectEffectfulHelperEscape(input, model, effectful);
  rejectUnreachableEffectfulHelpers(model, input.runNode, effectful, signatures);
  rejectUnreachableMutatingFunctions(model, input.runNode, signatures);
  validateDeterministicLanguage(input, model, signatures);
  validateBoundaryMutations(input, model, signatures);

  const descriptors = new Map(input.descriptors.map((descriptor) => [descriptor.binding, descriptor]));
  const calls = model.functions.flatMap((owner) =>
    directEffects.get(owner)!.map(({ node, method }) => ({ node, method, owner })))
    .sort((left, right) => left.node.start - right.node.start);
  const internalSites: InternalOperationSite[] = calls.map((call, index) => ({
    sourceSite: `site-${String(index).padStart(6, "0")}`,
    method: assertFlowMethod(call.method, call.node),
    function: model.names.get(call.owner)!,
    contexts: summarizeContexts(signatures.get(call.owner)!),
    location: sourceLocation(call.node),
    node: call.node,
    owner: call.owner,
  }));

  const metricBindings = collectMetricBindings(input, model, internalSites);
  const dynamicResources: WorkflowDynamicResourceUse[] = [];
  const candidateWrites: WorkflowCandidateWriteSite[] = [];
  const measurementProfiles = new Set<string>();
  const verificationProfiles = new Set<string>();
  const humanInteractionSites: string[] = [];
  const applySites: string[] = [];

  for (const site of internalSites) {
    validateOperationSite({
      input,
      model,
      site,
      descriptors,
      signatures: signatures.get(site.owner)!,
      metricBindings,
      dynamicResources,
      candidateWrites,
      measurementProfiles,
      verificationProfiles,
      humanInteractionSites,
      applySites,
    });
  }

  rejectDescriptorEscape(input, descriptors);
  const loops = collectNativeLoops(input, model, effectful);
  const capabilities = deriveCapabilities(
    input.descriptors,
    internalSites,
    dynamicResources,
  );
  const helpers = model.functions
    .filter((fn) => fn !== input.runNode && !model.names.get(fn)!.startsWith("<callback@"))
    .map((fn): WorkflowHelperSummary => ({
      name: model.names.get(fn)!,
      effectful: effectful.has(fn),
      contexts: summarizeContexts(signatures.get(fn)!),
      effects: directEffects.get(fn)!.map((effect) => assertFlowMethod(effect.method, effect.node)),
      location: sourceLocation(fn),
    }))
    .sort((left, right) => left.location.line - right.location.line
      || left.location.column - right.location.column
      || left.name.localeCompare(right.name));

  const operations = internalSites.map(({ node: _node, owner: _owner, ...site }) => site);
  const review: Omit<WorkflowReview, "maximumConcurrency"> = {
    capabilities: [...capabilities].sort(),
    agentProfiles: uniqueSorted(input.descriptors
      .filter((descriptor): descriptor is WorkflowAgentDescriptor => descriptor.kind === "agent-task")
      .map((descriptor) => descriptor.profile)),
    commandProfiles: uniqueSorted(input.descriptors
      .filter((descriptor): descriptor is WorkflowCommandDescriptor => descriptor.kind === "command-task")
      .map((descriptor) => descriptor.profile)),
    measurementProfiles: [...measurementProfiles].sort(),
    verificationProfiles: [...verificationProfiles].sort(),
    dynamicResources: dynamicResources.sort(compareDynamicResources),
    candidateWrites: candidateWrites.sort((left, right) => left.operationSite.localeCompare(right.operationSite)),
    usesCandidateWrites: capabilities.has("candidate-write"),
    usesMediatedNetwork: capabilities.has("mediated-network"),
    humanInteractionSites: [...humanInteractionSites].sort(),
    applySites: [...applySites].sort(),
    nativeLoops: loops,
    suspiciousUnboundedLoops: loops
      .filter((loop) => loop.bound === "unknown")
      .map((loop) => loop.location),
  };
  return {
    operations,
    operationNodes: internalSites.map((site) => ({ sourceSite: site.sourceSite, node: site.node })),
    helpers,
    review,
  };
}

interface ValidateOperationInput {
  input: AnalyzeWorkflowSourceInput;
  model: FunctionModel;
  site: InternalOperationSite;
  descriptors: ReadonlyMap<string, WorkflowDescriptor>;
  signatures: readonly ContextSignature[];
  metricBindings: readonly MetricBinding[];
  dynamicResources: WorkflowDynamicResourceUse[];
  candidateWrites: WorkflowCandidateWriteSite[];
  measurementProfiles: Set<string>;
  verificationProfiles: Set<string>;
  humanInteractionSites: string[];
  applySites: string[];
}

function validateOperationSite(state: ValidateOperationInput): void {
  const { input, model, site, signatures } = state;
  const call = site.node;
  const args = call.arguments ?? [];
  if (call.optional || call.callee?.optional) {
    throw new WorkflowScriptError("Flow operations may not use optional chaining", location(call));
  }
  if (site.method !== "metrics" && !isAwaitedOrReturned(input, call)) {
    throw new WorkflowScriptError(`flow.${site.method}() must be directly awaited or returned`, location(call));
  }
  for (const signature of signatures) {
    if (signature.some((entry) => entry.kind === "key")) {
      throw new WorkflowScriptError(`flow.${site.method} is unavailable in map key callbacks`, location(call));
    }
    if (signature.some((entry) => entry.kind === "concurrent") && CONCURRENT_FORBIDDEN.has(site.method)) {
      throw new WorkflowScriptError(`flow.${site.method} is unavailable in concurrent callbacks`, location(call));
    }
    if (lastBoundary(signature, "candidate") && CANDIDATE_FORBIDDEN.has(site.method)) {
      throw new WorkflowScriptError(`flow.${site.method} is unavailable inside candidate callbacks`, location(call));
    }
  }

  switch (site.method) {
    case "parallel":
      expectCallArguments(call, 1, 2);
      Object.assign(site, validateParallelCall(call));
      validateSiteConcurrency(input, site);
      break;
    case "map":
      expectCallArguments(call, 3, 3);
      Object.assign(site, validateMapCall(call));
      validateSiteConcurrency(input, site);
      break;
    case "candidate": {
      expectCallArguments(call, 1, 2);
      const callback = resolveCallback(model, site.owner, args[0]);
      if (!callback || callback.params.length !== 1 || callback.params[0]?.type !== "Identifier") {
        throw new WorkflowScriptError("flow.candidate requires one lexically known callback with a workspace parameter", location(args[0]));
      }
      const write = candidateWriteSite(state, args[1]);
      state.candidateWrites.push(write);
      break;
    }
    case "agent": {
      expectCallArguments(call, 2, 2);
      const descriptor = requireDescriptor(state, args[0], "agent-task");
      site.descriptorSourceSite = descriptor.identity.sourceSite;
      for (const signature of signatures) validateAgentContext(descriptor, signature, call);
      break;
    }
    case "command": {
      expectCallArguments(call, 1, 2);
      const descriptor = requireDescriptor(state, args[0], "command-task");
      site.descriptorSourceSite = descriptor.identity.sourceSite;
      for (const signature of signatures) validateCommandContext(descriptor, signature, call);
      break;
    }
    case "ask": {
      expectCallArguments(call, 1, 1);
      const request = requireLiteralObject(args[0], "flow.ask request");
      assertExactKeys(request, new Set(["prompt", "response", "title"]), "flow.ask request");
      const response = request.get("response");
      if (!response) throw new WorkflowScriptError("flow.ask requires response", location(args[0]));
      const responseSchema = input.schemaEvaluator.schema(response.value, "flow.ask response");
      if (collectWorkflowSchemaResources(responseSchema).length) {
        throw new WorkflowScriptError(
          "flow.ask response schemas may not mint invocation-selected resources",
          location(response.value),
        );
      }
      state.humanInteractionSites.push(site.sourceSite);
      break;
    }
    case "metrics":
      expectCallArguments(call, 1, 2);
      if (!isConstVariableInitializer(input, call)) {
        throw new WorkflowScriptError("flow.metrics() must initialize one const metric-set binding", location(call));
      }
      if (signatures.some((signature) => signature.length > 0)) {
        throw new WorkflowScriptError("flow.metrics() is available only in the root run scope", location(call));
      }
      break;
    case "measure": {
      expectCallArguments(call, 2, 3);
      const metric = resolveMetricBinding(model, state.metricBindings, site.owner, args[1]);
      if (!metric) throw new WorkflowScriptError("flow.measure requires a statically known metric set", location(args[1]));
      const profile = args[0];
      if (profile?.type === "Literal" && typeof profile.value === "string") {
        assertProfileSelector(profile.value, profile, "measurement profile");
        state.measurementProfiles.add(profile.value);
      } else {
        const inputPath = input.inputPath(profile);
        const schema = inputPath ? workflowSchemaAtPath(input.inputSchema, inputPath) : undefined;
        if (!inputPath || !isWorkflowMeasurementProfileSchema(schema)) {
          throw new WorkflowScriptError(
            "flow.measure profile must be a reviewed literal or s.measurementProfile() input",
            location(profile),
          );
        }
        if (!metric.policyPath) {
          throw new WorkflowScriptError(
            "An invocation-selected measurement profile requires a metric policy read directly from workflow input",
            location(args[1]),
          );
        }
        state.dynamicResources.push({
          kind: "measurement-profile",
          inputPath,
          operationSite: site.sourceSite,
          metricPolicyPath: metric.policyPath,
          ...(metric.samplingPath ? { samplingPath: metric.samplingPath } : {}),
        });
      }
      break;
    }
    case "verify": {
      expectCallArguments(call, 2, 2);
      const profile = staticString(args[1], "verification profile");
      assertProfileSelector(profile, args[1], "verification profile");
      state.verificationProfiles.add(profile);
      break;
    }
    case "accept":
      expectCallArguments(call, 2, 2);
      break;
    case "reject":
      expectCallArguments(call, 2, 2);
      break;
    case "recordExperiment":
      expectCallArguments(call, 1, 1);
      break;
    case "apply":
      expectCallArguments(call, 1, 1);
      state.applySites.push(site.sourceSite);
      state.humanInteractionSites.push(site.sourceSite);
      break;
  }
}

function validateSiteConcurrency(input: AnalyzeWorkflowSourceInput, site: InternalOperationSite): void {
  const ceiling = input.maximumConcurrency ?? DEFINITION_LIMITS.concurrency;
  if (site.requestedConcurrency !== undefined && site.requestedConcurrency > ceiling) {
    throw new WorkflowScriptError(
      `Requested concurrency ${site.requestedConcurrency} exceeds the workflow ceiling ${ceiling}`,
      location(site.node),
    );
  }
}

function validateAgentContext(
  descriptor: WorkflowAgentDescriptor,
  signature: ContextSignature,
  node: WorkflowAstNode,
): void {
  const candidateIndex = lastBoundaryIndex(signature, "candidate");
  if (descriptor.workspace === "candidate") {
    if (candidateIndex < 0) {
      throw new WorkflowScriptError(
        `Candidate agent descriptor ${descriptor.binding} may execute only inside a candidate callback`,
        location(node),
      );
    }
    if (signature.slice(candidateIndex + 1).some((entry) => entry.kind === "concurrent")) {
      throw new WorkflowScriptError("Candidate workspace authority may not be shared across concurrent lanes", location(node));
    }
  } else if (candidateIndex >= 0) {
    throw new WorkflowScriptError("Agent calls inside candidate callbacks require a candidate descriptor", location(node));
  }
}

function validateCommandContext(
  descriptor: WorkflowCommandDescriptor,
  signature: ContextSignature,
  node: WorkflowAstNode,
): void {
  const candidateIndex = lastBoundaryIndex(signature, "candidate");
  if (descriptor.effect === "candidate") {
    if (candidateIndex < 0) {
      throw new WorkflowScriptError(
        `Candidate command descriptor ${descriptor.binding} may execute only inside a candidate callback`,
        location(node),
      );
    }
    if (signature.slice(candidateIndex + 1).some((entry) => entry.kind === "concurrent")) {
      throw new WorkflowScriptError("Candidate workspace authority may not be shared across concurrent lanes", location(node));
    }
  } else if (candidateIndex >= 0) {
    throw new WorkflowScriptError("Command calls inside candidate callbacks require a candidate descriptor", location(node));
  }
}

function requireDescriptor<K extends WorkflowDescriptor["kind"]>(
  state: ValidateOperationInput,
  node: WorkflowAstNode,
  kind: K,
): Extract<WorkflowDescriptor, { kind: K }> {
  if (node?.type !== "Identifier") {
    throw new WorkflowScriptError(`flow.${state.site.method} requires a static ${kind} descriptor`, location(node));
  }
  const descriptor = state.descriptors.get(node.name);
  if (!descriptor || descriptor.kind !== kind) {
    throw new WorkflowScriptError(`flow.${state.site.method} requires a static ${kind} descriptor`, location(node));
  }
  return descriptor as Extract<WorkflowDescriptor, { kind: K }>;
}

function candidateWriteSite(
  state: ValidateOperationInput,
  optionsNode: WorkflowAstNode | undefined,
): WorkflowCandidateWriteSite {
  if (!optionsNode) return { operationSite: state.site.sourceSite, mode: "default" };
  const options = requireLiteralObject(optionsNode, "flow.candidate options");
  assertExactKeys(options, new Set(["base", "writes", "title"]), "flow.candidate options");
  const writes = options.get("writes")?.value;
  if (!writes) return { operationSite: state.site.sourceSite, mode: "default" };
  const inputPath = state.input.inputPath(writes);
  if (inputPath) {
    const schema = workflowSchemaAtPath(state.input.inputSchema, inputPath);
    if (!isSafeWriteSchema(schema)) {
      throw new WorkflowScriptError("Dynamic candidate writes require s.safePath() input authority", location(writes));
    }
    return { operationSite: state.site.sourceSite, mode: "input", inputPath };
  }
  let value: JsonValue;
  try { value = state.input.schemaEvaluator.json(writes, "flow.candidate writes"); }
  catch {
    throw new WorkflowScriptError(
      "Candidate writes must be static safe paths or read directly from s.safePath() input",
      location(writes),
    );
  }
  const paths = staticWritePaths(value, writes);
  return { operationSite: state.site.sourceSite, mode: "static", paths };
}

function staticWritePaths(value: JsonValue, node: WorkflowAstNode): string[] {
  let paths: JsonValue[];
  if (Array.isArray(value)) paths = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => key !== "allow" && key !== "deny") || !Array.isArray(record.allow)) {
      throw new WorkflowScriptError("Candidate write scope requires allow and optional deny arrays", location(node));
    }
    paths = [...record.allow, ...(Array.isArray(record.deny) ? record.deny : [])];
  } else throw new WorkflowScriptError("Candidate writes must be an array or write-scope object", location(node));
  if (paths.length > DEFINITION_LIMITS.candidateScopeRules
    || paths.some((entry) => typeof entry !== "string" || !isSafeRelativePath(entry))) {
    throw new WorkflowScriptError("Candidate writes contain too many or unsafe project-relative paths", location(node));
  }
  return [...new Set(paths as string[])].sort();
}

function isSafeWriteSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.type === "array") return isWorkflowSafePathSchema(schema.items as JsonSchema | undefined);
  if (schema.type !== "object") return false;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const allow = (properties as Record<string, JsonSchema>).allow;
  const deny = (properties as Record<string, JsonSchema>).deny;
  return Boolean(
    allow?.type === "array" && isWorkflowSafePathSchema(allow.items as JsonSchema | undefined)
    && (!deny || (deny.type === "array" && isWorkflowSafePathSchema(deny.items as JsonSchema | undefined))),
  );
}

function collectMetricBindings(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  sites: readonly InternalOperationSite[],
): MetricBinding[] {
  const result: MetricBinding[] = [];
  for (const site of sites.filter((entry) => entry.method === "metrics")) {
    const parent = input.parents.get(site.node)?.parent;
    if (parent?.type !== "VariableDeclarator" || parent.init !== site.node || parent.id?.type !== "Identifier") continue;
    const declaration = input.parents.get(parent)?.parent;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    if (result.some((entry) => entry.owner === site.owner && entry.name === parent.id.name)) {
      throw new WorkflowScriptError(`Duplicate metric-set binding ${parent.id.name}`, location(parent.id));
    }
    result.push({
      name: parent.id.name,
      owner: site.owner,
      ...(input.inputPath(site.node.arguments?.[0]) ? { policyPath: input.inputPath(site.node.arguments[0]) } : {}),
      ...(input.inputPath(site.node.arguments?.[1]) ? { samplingPath: input.inputPath(site.node.arguments[1]) } : {}),
    });
  }
  return result;
}

function resolveMetricBinding(
  model: FunctionModel,
  bindings: readonly MetricBinding[],
  owner: WorkflowAstNode,
  node: WorkflowAstNode,
): MetricBinding | undefined {
  if (node?.type !== "Identifier") return undefined;
  for (let current: WorkflowAstNode | undefined = owner; current; current = model.parentFunction.get(current)) {
    const binding = bindings.find((entry) => entry.owner === current && entry.name === node.name);
    if (binding) return binding;
    if (model.declaredNames.get(current)?.has(node.name)) return undefined;
  }
  return undefined;
}

function isConstVariableInitializer(input: AnalyzeWorkflowSourceInput, node: WorkflowAstNode): boolean {
  const declarator = input.parents.get(node)?.parent;
  const declaration = declarator ? input.parents.get(declarator)?.parent : undefined;
  return declarator?.type === "VariableDeclarator" && declarator.init === node
    && declarator.id?.type === "Identifier"
    && declaration?.type === "VariableDeclaration" && declaration.kind === "const";
}

function buildFunctionModel(input: AnalyzeWorkflowSourceInput): FunctionModel {
  const functions: WorkflowAstNode[] = [];
  walk(input.ast, (node) => { if (isFunction(node)) functions.push(node); });
  if (!functions.includes(input.runNode)) functions.push(input.runNode);
  functions.sort((left, right) => left.start - right.start);
  const functionSet = new Set(functions);
  const parentFunction = new Map<WorkflowAstNode, WorkflowAstNode | undefined>();
  const functionBindings = new Map<WorkflowAstNode | undefined, Map<string, WorkflowAstNode>>();
  const declaredNames = new Map<WorkflowAstNode, Set<string>>();
  const parameterNames = new Map<WorkflowAstNode, Set<string>>();
  const names = new Map<WorkflowAstNode, string>();

  for (const fn of functions) {
    let current = input.parents.get(fn)?.parent;
    while (current && !functionSet.has(current)) current = input.parents.get(current)?.parent;
    parentFunction.set(fn, current && isFunction(current) ? current : undefined);
  }
  const addBinding = (owner: WorkflowAstNode | undefined, name: string, fn: WorkflowAstNode, node: WorkflowAstNode): void => {
    const bindings = functionBindings.get(owner) ?? new Map<string, WorkflowAstNode>();
    const existing = bindings.get(name);
    if (existing && existing !== fn) throw new WorkflowScriptError(`Duplicate workflow helper ${name}`, location(node));
    bindings.set(name, fn);
    functionBindings.set(owner, bindings);
    if (!names.has(fn)) names.set(fn, name);
  };

  walk(input.ast, (node, parent) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      addBinding(parentFunction.get(node), node.id.name, node, node.id);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFunction(node.init)) {
      const owner = nearestFunctionFromNode(input, node);
      addBinding(owner, node.id.name, node.init, node.id);
    }
    if ((node.type === "FunctionExpression" || node.type === "FunctionDeclaration") && node.id?.name) {
      const own = functionBindings.get(node) ?? new Map<string, WorkflowAstNode>();
      own.set(node.id.name, node);
      functionBindings.set(node, own);
    }
    if (isFunction(node) && parent && !names.has(node)) {
      const loc = sourceLocation(node);
      names.set(node, `<callback@${loc.line}:${loc.column}>`);
    }
  });
  names.set(input.runNode, "run");

  for (const fn of functions) {
    const parameters = new Set<string>();
    for (const parameter of fn.params ?? []) collectPatternNames(parameter, parameters);
    parameterNames.set(fn, parameters);
    const declared = new Set(parameters);
    if (fn.id?.name) declared.add(fn.id.name);
    walkOwn(fn.body, (node) => {
      if (node.type === "VariableDeclarator") collectPatternNames(node.id, declared);
      if (node.type === "FunctionDeclaration" && node.id?.name) declared.add(node.id.name);
      if (node.type === "CatchClause" && node.param) collectPatternNames(node.param, declared);
    });
    declaredNames.set(fn, declared);
  }
  return { functions, parentFunction, functionBindings, declaredNames, parameterNames, names };
}

function nearestFunctionFromNode(
  input: AnalyzeWorkflowSourceInput,
  node: WorkflowAstNode,
): WorkflowAstNode | undefined {
  let current = input.parents.get(node)?.parent;
  while (current) {
    if (isFunction(current)) return current;
    current = input.parents.get(current)?.parent;
  }
  return undefined;
}

function resolveFunctionBinding(
  model: FunctionModel,
  owner: WorkflowAstNode,
  name: string,
): WorkflowAstNode | undefined {
  for (let current: WorkflowAstNode | undefined = owner; ; current = current ? model.parentFunction.get(current) : undefined) {
    const binding = model.functionBindings.get(current)?.get(name);
    if (binding) return binding;
    if (current && model.declaredNames.get(current)?.has(name)) return undefined;
    if (!current) return undefined;
  }
}

function markStructuredCallbacks(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  owner: WorkflowAstNode,
  call: WorkflowAstNode,
  method: string,
  edges: Map<WorkflowAstNode, FunctionEdge[]>,
): void {
  const mark = (node: WorkflowAstNode, kind: ContextBoundaryKind): void => {
    const target = resolveCallback(model, owner, node);
    if (!target) throw new WorkflowScriptError(`flow.${method} requires a lexically known callback`, location(node));
    edges.get(owner)!.push({ target, kind, node });
  };
  if (method === "map") {
    mark(call.arguments?.[1], "concurrent");
    mark(call.arguments?.[2]?.type === "ObjectExpression"
      ? objectProperties(call.arguments[2], "flow.map options").get("key")?.value
      : undefined, "key");
  } else if (method === "candidate") {
    mark(call.arguments?.[0], "candidate");
  } else if (method === "parallel") {
    const branches = call.arguments?.[0];
    if (branches?.type !== "ObjectExpression") {
      throw new WorkflowScriptError("flow.parallel branches must be a literal object", location(branches));
    }
    for (const property of objectProperties(branches, "flow.parallel branches").values()) {
      mark(property.value, "concurrent");
    }
  }
}

function resolveCallback(
  model: FunctionModel,
  owner: WorkflowAstNode,
  node: WorkflowAstNode | undefined,
): WorkflowAstNode | undefined {
  if (isFunction(node)) return node;
  if (node?.type === "Identifier") return resolveFunctionBinding(model, owner, node.name);
  return undefined;
}

function rejectRecursiveFunctionGraph(
  model: FunctionModel,
  edges: ReadonlyMap<WorkflowAstNode, readonly FunctionEdge[]>,
): void {
  const active = new Set<WorkflowAstNode>();
  const done = new Set<WorkflowAstNode>();
  const visit = (fn: WorkflowAstNode): void => {
    if (active.has(fn)) {
      throw new WorkflowScriptError(`Recursive workflow helper ${model.names.get(fn)} is unavailable`, location(fn));
    }
    if (done.has(fn)) return;
    active.add(fn);
    for (const edge of edges.get(fn) ?? []) visit(edge.target);
    active.delete(fn);
    done.add(fn);
  };
  for (const fn of model.functions) visit(fn);
}

function propagateContextSignatures(
  runNode: WorkflowAstNode,
  functions: readonly WorkflowAstNode[],
  edges: ReadonlyMap<WorkflowAstNode, readonly FunctionEdge[]>,
): Map<WorkflowAstNode, ContextSignature[]> {
  const signatures = new Map(functions.map((fn) => [fn, [] as ContextSignature[]]));
  signatures.get(runNode)!.push([]);
  let changed = true;
  let rounds = 0;
  while (changed) {
    if (++rounds > functions.length + 2) throw new Error("Workflow helper context propagation did not converge");
    changed = false;
    for (const fn of functions) {
      for (const edge of edges.get(fn) ?? []) {
        for (const signature of signatures.get(fn)!) {
          const next = edge.kind === "direct"
            ? signature
            : [...signature, { kind: edge.kind, root: edge.target }];
          const target = signatures.get(edge.target)!;
          if (!target.some((current) => sameSignature(current, next))) {
            if (target.length >= 256) throw new WorkflowScriptError("Workflow helper has too many execution contexts", location(edge.node));
            target.push(next);
            changed = true;
          }
        }
      }
    }
  }
  return signatures;
}

function effectfulFunctions(
  functions: readonly WorkflowAstNode[],
  direct: ReadonlyMap<WorkflowAstNode, readonly DirectEffect[]>,
  edges: ReadonlyMap<WorkflowAstNode, readonly FunctionEdge[]>,
): Set<WorkflowAstNode> {
  const result = new Set(functions.filter((fn) => (direct.get(fn)?.length ?? 0) > 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (result.has(fn)) continue;
      if ((edges.get(fn) ?? []).some((edge) => result.has(edge.target))) {
        result.add(fn);
        changed = true;
      }
    }
  }
  return result;
}

function rejectUnreachableEffectfulHelpers(
  model: FunctionModel,
  runNode: WorkflowAstNode,
  effectful: ReadonlySet<WorkflowAstNode>,
  signatures: ReadonlyMap<WorkflowAstNode, readonly ContextSignature[]>,
): void {
  for (const fn of effectful) {
    if (fn !== runNode && signatures.get(fn)?.length === 0) {
      throw new WorkflowScriptError(`Effectful helper ${model.names.get(fn)} is unreachable from run`, location(fn));
    }
  }
}

function rejectUnreachableMutatingFunctions(
  model: FunctionModel,
  runNode: WorkflowAstNode,
  signatures: ReadonlyMap<WorkflowAstNode, readonly ContextSignature[]>,
): void {
  for (const fn of model.functions) {
    if (fn === runNode || (signatures.get(fn)?.length ?? 0) > 0) continue;
    let mutation: WorkflowAstNode | undefined;
    walkOwn(fn.body, (node) => {
      if (isMutationNode(node)) { mutation = node; return false; }
      return undefined;
    });
    if (mutation) {
      throw new WorkflowScriptError(
        `State-mutating helper ${model.names.get(fn)} must be invoked through a direct lexical call`,
        location(mutation),
      );
    }
  }
}

function rejectEffectfulHelperEscape(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  effectful: ReadonlySet<WorkflowAstNode>,
): void {
  walk(input.ast, (node, parent, key) => {
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) return;
    const owner = nearestFunctionFromNode(input, node);
    if (!owner) return;
    const fn = resolveFunctionBinding(model, owner, node.name);
    if (!fn || !effectful.has(fn) || isFunctionDeclarationIdentifier(node, parent, key)) return;
    if (parent?.type === "CallExpression" && key === "callee") return;
    if (isExactStructuredCallback(input, parent, node, key)) return;
    throw new WorkflowScriptError(
      `Effectful helper ${node.name} may not escape or use dynamic dispatch`,
      location(node),
    );
  });
}

function isExactStructuredCallback(
  input: AnalyzeWorkflowSourceInput,
  parent: WorkflowAstNode | undefined,
  node: WorkflowAstNode,
  key: string | undefined,
): boolean {
  if (parent?.type === "CallExpression") {
    const method = flowMethod(parent, input.flowName);
    if (method === "map") return parent.arguments?.[1] === node;
    if (method === "candidate") return parent.arguments?.[0] === node;
  }
  if (parent?.type !== "Property" || key !== "value" || parent.value !== node) return false;
  const object = input.parents.get(parent)?.parent;
  const call = object ? input.parents.get(object)?.parent : undefined;
  return object?.type === "ObjectExpression"
    && call?.type === "CallExpression"
    && flowMethod(call, input.flowName) === "parallel"
    && call.arguments?.[0] === object;
}

function validateDeterministicLanguage(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  signatures: ReadonlyMap<WorkflowAstNode, readonly ContextSignature[]>,
): void {
  const topBindings = topLevelBindings(input.ast);
  walk(input.ast, (node, parent, key) => {
    if (node.type === "ImportExpression") throw new WorkflowScriptError("Dynamic imports are unavailable", location(node));
    if (node.type === "MetaProperty") throw new WorkflowScriptError("import.meta is unavailable", location(node));
    if (node.type === "ForOfStatement" && node.await) throw new WorkflowScriptError("for await is unavailable", location(node));
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      throw new WorkflowScriptError("Classes are unavailable in deterministic workflow control", location(node));
    }
    if (node.type === "ThisExpression" || node.type === "Super") {
      throw new WorkflowScriptError("this/super are unavailable in workflow control", location(node));
    }
    if (node.type === "YieldExpression") throw new WorkflowScriptError("Generators are unavailable", location(node));
    if (node.type === "Identifier") validateIdentifier(input, model, topBindings, node, parent, key);
    if (node.type === "MemberExpression") validateMember(input, node, parent, key);
    if (node.type === "NewExpression" && node.callee?.type === "Identifier"
      && ["Function", "Promise", "Date"].includes(node.callee.name)) {
      throw new WorkflowScriptError(`new ${node.callee.name}() is unavailable`, location(node));
    }
    if (node.type === "CallExpression") {
      if (node.callee?.type === "Identifier" && ["eval", "Function", "Date"].includes(node.callee.name)) {
        throw new WorkflowScriptError(`Forbidden call ${node.callee.name}()`, location(node));
      }
      if (node.callee?.type === "MemberExpression" && node.callee.object?.type === "Identifier"
        && node.callee.object.name === "Promise") {
        throw new WorkflowScriptError("Direct Promise concurrency is forbidden; use flow.parallel()/flow.map()", location(node));
      }
      if (node.callee?.type === "MemberExpression" && node.callee.object?.type === "Identifier"
        && ["Object", "Reflect"].includes(node.callee.object.name)
        && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(memberPropertyName(node.callee) ?? "")) {
        throw new WorkflowScriptError("Reflective mutation is unavailable", location(node));
      }
    }
  });

  for (const fn of model.functions) {
    if (signatures.get(fn)?.some((signature) => signature.some((entry) => entry.kind === "key"))) {
      walkOwn(fn.body, (node) => {
        if (isMutationNode(node)) throw new WorkflowScriptError("Map key callbacks may not mutate state", location(node));
        if (node.type === "CallExpression" && !flowMethod(node, input.flowName)) {
          throw new WorkflowScriptError("Map key callbacks may only derive keys from item data", location(node));
        }
      });
    }
  }
}

function validateIdentifier(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  topBindings: ReadonlySet<string>,
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): void {
  if (isNoncomputedPropertyKey(node, parent, key)) return;
  const declaration = isDeclarationIdentifier(node, parent, key);
  if (node.name.startsWith("__flow")) {
    throw new WorkflowScriptError(`Reserved workflow binding ${node.name}`, location(node));
  }
  if (declaration && (FORBIDDEN_IDENTIFIERS.has(node.name) || AMBIENT_TIME_IDENTIFIERS.has(node.name))) {
    throw new WorkflowScriptError(`Reserved workflow binding ${node.name}`, location(node));
  }
  const owner = nearestFunctionFromNode(input, node);
  const bound = owner ? resolveBindingOwner(model, owner, node.name) !== undefined || topBindings.has(node.name) : topBindings.has(node.name);
  if (!declaration && !bound && FORBIDDEN_IDENTIFIERS.has(node.name)) {
    throw new WorkflowScriptError(`Forbidden ambient API ${node.name}`, location(node));
  }
  if (!declaration && !bound && AMBIENT_TIME_IDENTIFIERS.has(node.name)) {
    throw new WorkflowScriptError("Ambient time is unavailable", location(node));
  }
  if (node.name === input.flowName && !declaration
    && !(parent?.type === "MemberExpression" && key === "object")) {
    throw new WorkflowScriptError("The flow API may not be aliased or passed as a value", location(node));
  }
  if (node.name === "Math" && !bound && !declaration
    && !(parent?.type === "MemberExpression" && key === "object" && !parent.computed)) {
    throw new WorkflowScriptError("Ambient Math requires static deterministic property access", location(node));
  }
}

function validateMember(
  input: AnalyzeWorkflowSourceInput,
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): void {
  const property = memberPropertyName(node);
  if (property && FORBIDDEN_PROPERTIES.has(property)) {
    throw new WorkflowScriptError(`Forbidden property access ${property}`, location(node));
  }
  if (node.object?.type === "Identifier" && node.object.name === "Math") {
    if (node.computed) throw new WorkflowScriptError("Ambient Math properties must use static access", location(node));
    if (property === "random") throw new WorkflowScriptError("Math.random() is unavailable", location(node));
  }
  if (node.object?.type !== "Identifier" || node.object.name !== input.flowName) return;
  if (node.computed) throw new WorkflowScriptError("Flow API members require static access", location(node));
  if (property === "snapshot") return;
  if (!property || !FLOW_METHOD_SET.has(property)) {
    throw new WorkflowScriptError(`Unknown flow API member ${property ?? "<computed>"}`, location(node));
  }
  if (!(parent?.type === "CallExpression" && key === "callee")) {
    throw new WorkflowScriptError("Flow methods may not be aliased or passed as values", location(node));
  }
}

function validateBoundaryMutations(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  signatures: ReadonlyMap<WorkflowAstNode, readonly ContextSignature[]>,
): void {
  for (const fn of model.functions) {
    const functionSignatures = signatures.get(fn) ?? [];
    const boundarySignatures = functionSignatures.filter((signature) =>
      signature.some((entry) => entry.kind === "candidate" || entry.kind === "concurrent"));
    const parameterAliases = aliasesFromUnsafeSources(input, model, fn, undefined);
    walkOwn(fn.body, (node) => {
      if (!isMutationNode(node)) return;
      const target = mutationTarget(node);
      const root = rootIdentifier(target);
      if (!root) {
        if (mutatesReferencedValue(node)) {
          throw new WorkflowScriptError("Workflow control may not mutate state returned by a call", location(node));
        }
        return;
      }
      const owner = resolveBindingOwner(model, fn, root);
      const directBindingWrite = !mutatesReferencedValue(node) && target?.type === "Identifier";
      if (owner === undefined || root === input.flowName) {
        throw new WorkflowScriptError(`Workflow control may not mutate frozen binding ${root}`, location(node));
      }
      if (!directBindingWrite && parameterAliases.has(root)) {
        throw new WorkflowScriptError(`Workflow control may not mutate parameter-derived state ${root}`, location(node));
      }
      for (const signature of boundarySignatures) {
        for (const boundary of signature.filter((entry) => entry.kind !== "key")) {
          const aliases = aliasesFromUnsafeSources(input, model, fn, boundary.root);
          const safe = bindingSafeForBoundary(model, fn, owner, boundary.root);
          if (mutationSources(node).some((source) =>
            expressionCapturesOutsideBoundary(model, fn, source, boundary.root))) {
            throw new WorkflowScriptError(
              `${boundary.kind} callback may not store captured state in mutable binding ${root}`,
              location(node),
            );
          }
          if (!safe || (!directBindingWrite && aliases.has(root))) {
            throw new WorkflowScriptError(
              `${boundary.kind} callback may not mutate captured binding ${root}`,
              location(node),
            );
          }
        }
      }
    });
  }
}

function aliasesFromUnsafeSources(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  fn: WorkflowAstNode,
  boundary: WorkflowAstNode | undefined,
): Set<string> {
  const aliases = new Set(model.parameterNames.get(fn) ?? []);
  const assignments: Array<{ targets: string[]; source?: WorkflowAstNode }> = [];
  walkOwn(fn.body, (node) => {
    if (node.type === "VariableDeclarator") {
      const names = new Set<string>();
      collectPatternNames(node.id, names);
      assignments.push({ targets: [...names], source: node.init });
    }
    if (node.type === "AssignmentExpression" && node.operator === "=" && node.left?.type === "Identifier") {
      assignments.push({ targets: [node.left.name], source: node.right });
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (!expressionAliasesUnsafe(input, model, fn, assignment.source, aliases, boundary)) continue;
      for (const target of assignment.targets) {
        if (!aliases.has(target)) { aliases.add(target); changed = true; }
      }
    }
  }
  return aliases;
}

function expressionAliasesUnsafe(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  fn: WorkflowAstNode,
  node: WorkflowAstNode | undefined,
  aliases: ReadonlySet<string>,
  boundary: WorkflowAstNode | undefined,
): boolean {
  if (!node) return false;
  if (node.type === "Identifier") {
    const owner = resolveBindingOwner(model, fn, node.name);
    return aliases.has(node.name) || owner === undefined
      || (boundary !== undefined && !bindingSafeForBoundary(model, fn, owner, boundary));
  }
  if (node.type === "MemberExpression") return expressionAliasesUnsafe(input, model, fn, node.object, aliases, boundary);
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return expressionAliasesUnsafe(input, model, fn, node.expression ?? node.argument, aliases, boundary);
  }
  if (node.type === "AssignmentExpression") {
    return expressionAliasesUnsafe(input, model, fn, node.right, aliases, boundary);
  }
  if (node.type === "ConditionalExpression") {
    return expressionAliasesUnsafe(input, model, fn, node.consequent, aliases, boundary)
      || expressionAliasesUnsafe(input, model, fn, node.alternate, aliases, boundary);
  }
  if (node.type === "LogicalExpression") {
    return expressionAliasesUnsafe(input, model, fn, node.left, aliases, boundary)
      || expressionAliasesUnsafe(input, model, fn, node.right, aliases, boundary);
  }
  if (node.type === "SequenceExpression") {
    return expressionAliasesUnsafe(input, model, fn, node.expressions.at(-1), aliases, boundary);
  }
  if (node.type === "ArrayExpression") {
    return node.elements.some((entry: WorkflowAstNode | null) =>
      entry?.type === "SpreadElement"
        ? expressionAliasesUnsafe(input, model, fn, entry.argument, aliases, boundary)
        : expressionAliasesUnsafe(input, model, fn, entry, aliases, boundary));
  }
  if (node.type === "ObjectExpression") {
    return node.properties.some((property: WorkflowAstNode) =>
      expressionAliasesUnsafe(
        input,
        model,
        fn,
        property.type === "SpreadElement" ? property.argument : property.value,
        aliases,
        boundary,
      ));
  }
  if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
    && FRESH_CONTAINER_METHODS.has(memberPropertyName(node.callee) ?? "")
    && !expressionAliasesUnsafe(input, model, fn, node.callee.object, aliases, boundary)
    && node.arguments.every((argument: WorkflowAstNode) =>
      argument.type !== "SpreadElement"
      && !expressionAliasesUnsafe(input, model, fn, argument, aliases, boundary))) {
    return false;
  }
  return node.type === "CallExpression";
}

function mutationSources(node: WorkflowAstNode): WorkflowAstNode[] {
  if (node.type === "AssignmentExpression") return [node.right];
  if (node.type === "CallExpression") {
    return (node.arguments ?? []).map((argument: WorkflowAstNode) =>
      argument.type === "SpreadElement" ? argument.argument : argument);
  }
  return [];
}

function expressionCapturesOutsideBoundary(
  model: FunctionModel,
  fn: WorkflowAstNode,
  node: WorkflowAstNode | undefined,
  boundary: WorkflowAstNode,
): boolean {
  if (!node) return false;
  if (node.type === "Identifier") {
    const owner = resolveBindingOwner(model, fn, node.name);
    return owner === undefined || !bindingSafeForBoundary(model, fn, owner, boundary);
  }
  if (node.type === "MemberExpression") {
    return expressionCapturesOutsideBoundary(model, fn, node.object, boundary);
  }
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return expressionCapturesOutsideBoundary(model, fn, node.expression ?? node.argument, boundary);
  }
  if (node.type === "ArrayExpression") {
    return node.elements.some((entry: WorkflowAstNode | null) =>
      entry?.type === "SpreadElement"
        ? expressionCapturesOutsideBoundary(model, fn, entry.argument, boundary)
        : expressionCapturesOutsideBoundary(model, fn, entry, boundary));
  }
  if (node.type === "ObjectExpression") {
    return node.properties.some((property: WorkflowAstNode) =>
      expressionCapturesOutsideBoundary(
        model,
        fn,
        property.type === "SpreadElement" ? property.argument : property.value,
        boundary,
      ));
  }
  if (node.type === "ConditionalExpression") {
    return expressionCapturesOutsideBoundary(model, fn, node.consequent, boundary)
      || expressionCapturesOutsideBoundary(model, fn, node.alternate, boundary);
  }
  if (node.type === "LogicalExpression") {
    return expressionCapturesOutsideBoundary(model, fn, node.left, boundary)
      || expressionCapturesOutsideBoundary(model, fn, node.right, boundary);
  }
  if (node.type === "SequenceExpression") {
    return expressionCapturesOutsideBoundary(model, fn, node.expressions.at(-1), boundary);
  }
  if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
    && FRESH_CONTAINER_METHODS.has(memberPropertyName(node.callee) ?? "")
    && !expressionCapturesOutsideBoundary(model, fn, node.callee.object, boundary)
    && node.arguments.every((argument: WorkflowAstNode) =>
      !expressionCapturesOutsideBoundary(
        model,
        fn,
        argument.type === "SpreadElement" ? argument.argument : argument,
        boundary,
      ))) {
    return false;
  }
  return node.type === "CallExpression";
}

function bindingSafeForBoundary(
  model: FunctionModel,
  current: WorkflowAstNode,
  owner: WorkflowAstNode,
  boundary: WorkflowAstNode,
): boolean {
  if (owner === current) return true;
  let cursor: WorkflowAstNode | undefined = current;
  while (cursor) {
    if (cursor === owner) return isLexicalAncestor(model, boundary, current);
    if (cursor === boundary) break;
    cursor = model.parentFunction.get(cursor);
  }
  return owner === boundary;
}

function isLexicalAncestor(model: FunctionModel, ancestor: WorkflowAstNode, child: WorkflowAstNode): boolean {
  for (let current: WorkflowAstNode | undefined = child; current; current = model.parentFunction.get(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

function resolveBindingOwner(
  model: FunctionModel,
  functionNode: WorkflowAstNode,
  name: string,
): WorkflowAstNode | undefined {
  for (let current: WorkflowAstNode | undefined = functionNode; current; current = model.parentFunction.get(current)) {
    if (model.declaredNames.get(current)?.has(name)) return current;
  }
  return undefined;
}

function rejectDescriptorEscape(
  input: AnalyzeWorkflowSourceInput,
  descriptors: ReadonlyMap<string, WorkflowDescriptor>,
): void {
  walk(input.ast, (node, parent, key) => {
    if (node.type !== "Identifier" || !descriptors.has(node.name)) return;
    if (parent?.type === "VariableDeclarator" && key === "id") return;
    if (isNoncomputedPropertyKey(node, parent, key)) return;
    if (parent?.type === "CallExpression") {
      const method = flowMethod(parent, input.flowName);
      if ((method === "agent" || method === "command") && parent.arguments?.[0] === node) return;
    }
    throw new WorkflowScriptError(`Task descriptor ${node.name} may only be passed directly to its flow operation`, location(node));
  });
}

function collectNativeLoops(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  effectful: ReadonlySet<WorkflowAstNode>,
): WorkflowNativeLoop[] {
  const result: Array<WorkflowNativeLoop & { start: number }> = [];
  walk(input.runNode.body, (node) => {
    const kind = loopKind(node);
    if (!kind) return;
    result.push({
      kind,
      bound: loopBound(input, node, kind),
      containsEffects: loopContainsEffects(input, model, effectful, node.body),
      location: sourceLocation(node),
      start: node.start,
    });
  });
  return result.sort((left, right) => left.start - right.start)
    .map(({ start: _start, ...loop }) => loop);
}

function loopKind(node: WorkflowAstNode): WorkflowNativeLoop["kind"] | undefined {
  if (node.type === "ForStatement") return "for";
  if (node.type === "ForOfStatement") return "for-of";
  if (node.type === "ForInStatement") return "for-in";
  if (node.type === "WhileStatement") return "while";
  if (node.type === "DoWhileStatement") return "do-while";
  return undefined;
}

function loopBound(
  input: AnalyzeWorkflowSourceInput,
  node: WorkflowAstNode,
  kind: WorkflowNativeLoop["kind"],
): WorkflowNativeLoop["bound"] {
  if (kind === "for-of" || kind === "for-in") return "finite-iterable";
  if (kind !== "for") return "unknown";
  const counter = updatedLoopCounter(node.update);
  if (!counter || containsLogicalOr(node.test)) return "unknown";
  let result: WorkflowNativeLoop["bound"] = "unknown";
  walk(node.test, (candidate) => {
    if (candidate.type !== "BinaryExpression" || !["<", "<=", ">", ">="].includes(candidate.operator)) return;
    const leftIsCounter = candidate.left?.type === "Identifier" && candidate.left.name === counter;
    const rightIsCounter = candidate.right?.type === "Identifier" && candidate.right.name === counter;
    if (!leftIsCounter && !rightIsCounter) return;
    const bound = leftIsCounter ? candidate.right : candidate.left;
    if (bound?.type === "Literal" && Number.isSafeInteger(bound.value) && bound.value >= 0) {
      result = "literal";
      return;
    }
    let schemaBounded = false;
    walk(bound, (part) => {
      const inputPath = input.inputPath(part);
      const inputSchema = inputPath ? workflowSchemaAtPath(input.inputSchema, inputPath) : undefined;
      if (inputSchema && (typeof inputSchema.maximum === "number" || typeof inputSchema.exclusiveMaximum === "number")) {
        schemaBounded = true;
      }
    });
    if (schemaBounded) result = "input-schema";
  });
  return result;
}

function updatedLoopCounter(node: WorkflowAstNode | undefined): string | undefined {
  if (node?.type === "UpdateExpression" && ["++", "--"].includes(node.operator)
    && node.argument?.type === "Identifier") return node.argument.name;
  if (node?.type === "AssignmentExpression" && ["+=", "-="].includes(node.operator)
    && node.left?.type === "Identifier" && node.right?.type === "Literal"
    && typeof node.right.value === "number" && node.right.value !== 0) return node.left.name;
  return undefined;
}

function containsLogicalOr(node: WorkflowAstNode | undefined): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (candidate.type === "LogicalExpression" && candidate.operator === "||") {
      found = true;
      return false;
    }
    return found ? false : undefined;
  });
  return found;
}

function loopContainsEffects(
  input: AnalyzeWorkflowSourceInput,
  model: FunctionModel,
  effectful: ReadonlySet<WorkflowAstNode>,
  body: WorkflowAstNode,
): boolean {
  let found = false;
  walk(body, (node) => {
    if (found) return false;
    if (flowMethod(node, input.flowName)) { found = true; return false; }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      const owner = nearestFunctionFromNode(input, node);
      const target = owner ? resolveFunctionBinding(model, owner, node.callee.name) : undefined;
      if (target && effectful.has(target)) { found = true; return false; }
    }
    return undefined;
  });
  return found;
}

function deriveCapabilities(
  descriptors: readonly WorkflowDescriptor[],
  operations: readonly InternalOperationSite[],
  dynamicResources: readonly WorkflowDynamicResourceUse[],
): Set<WorkflowCapability> {
  const result = new Set<WorkflowCapability>();
  for (const descriptor of descriptors) {
    if (descriptor.kind === "agent-task") {
      result.add("read-project");
      if (descriptor.workspace === "candidate") result.add("candidate-write");
      if (descriptor.network === "research") result.add("mediated-network");
    } else {
      result.add("host-command");
      if (descriptor.effect === "candidate") result.add("candidate-write");
    }
  }
  for (const operation of operations) {
    if (operation.method === "ask") result.add("human-input");
    if (operation.method === "measure") result.add("host-command");
    if (["candidate", "verify", "accept", "reject", "recordExperiment", "apply"].includes(operation.method)) {
      result.add("candidate-write");
    }
    if (operation.method === "apply") result.add("human-input");
  }
  if (dynamicResources.length) result.add("host-command");
  return result;
}

function validateParallelCall(call: WorkflowAstNode): Pick<WorkflowOperationSite, "parallelKeys" | "errors" | "requestedConcurrency"> {
  const branches = requireLiteralObject(call.arguments?.[0], "flow.parallel branches");
  if (branches.size < 1 || branches.size > DEFINITION_LIMITS.parallelBranches) {
    throw new WorkflowScriptError(
      `flow.parallel requires 1–${DEFINITION_LIMITS.parallelBranches} branches`,
      location(call.arguments?.[0]),
    );
  }
  for (const [name, property] of branches) {
    if (!FLOW_NAME_PATTERN.test(name)) throw new WorkflowScriptError(`Invalid parallel branch key ${name}`, location(property.key));
    if (!isFunction(property.value) && property.value?.type !== "Identifier") {
      throw new WorkflowScriptError(`Parallel branch ${name} must be a lexically known callback`, location(property.value));
    }
  }
  const options = call.arguments?.[1]
    ? validateConcurrencyOptions(call.arguments[1], "flow.parallel options", new Set(["concurrency", "errors"]))
    : { errors: "fail-fast" as const };
  return { parallelKeys: [...branches.keys()], ...options };
}

function validateMapCall(call: WorkflowAstNode): Pick<WorkflowOperationSite, "errors" | "requestedConcurrency"> {
  const options = requireLiteralObject(call.arguments?.[2], "flow.map options");
  assertExactKeys(options, new Set(["key", "concurrency", "errors"]), "flow.map options");
  if (!options.has("key")) throw new WorkflowScriptError("flow.map options require key", location(call.arguments?.[2]));
  return validateConcurrencyOptions(
    call.arguments[2],
    "flow.map options",
    new Set(["key", "concurrency", "errors"]),
  );
}

function validateConcurrencyOptions(
  node: WorkflowAstNode,
  label: string,
  allowed: ReadonlySet<string>,
): Pick<WorkflowOperationSite, "errors" | "requestedConcurrency"> {
  const options = requireLiteralObject(node, label);
  for (const key of options.keys()) {
    if (!allowed.has(key)) {
      throw new WorkflowScriptError(`${label} contains unknown field ${key}`, location(options.get(key)));
    }
  }
  const concurrency = options.get("concurrency")?.value;
  if (concurrency && (concurrency.type !== "Literal" || !Number.isSafeInteger(concurrency.value)
    || concurrency.value < 1 || concurrency.value > DEFINITION_LIMITS.concurrency)) {
    throw new WorkflowScriptError(`Concurrency must be 1–${DEFINITION_LIMITS.concurrency}`, location(concurrency));
  }
  const errors = options.get("errors")?.value;
  if (errors && (errors.type !== "Literal" || !["fail-fast", "collect"].includes(errors.value))) {
    throw new WorkflowScriptError("Concurrency errors must be fail-fast or collect", location(errors));
  }
  return {
    ...(concurrency ? { requestedConcurrency: concurrency.value as number } : {}),
    errors: errors ? errors.value as "fail-fast" | "collect" : "fail-fast",
  };
}

function requireLiteralObject(node: WorkflowAstNode | undefined, label: string): Map<string, WorkflowAstNode> {
  if (node?.type !== "ObjectExpression") throw new WorkflowScriptError(`${label} must be a literal object`, location(node));
  return objectProperties(node, label);
}

function assertExactKeys(
  properties: ReadonlyMap<string, WorkflowAstNode>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const [name, property] of properties) {
    if (!allowed.has(name)) throw new WorkflowScriptError(`${label} contains unknown field ${name}`, location(property));
  }
}

function expectCallArguments(call: WorkflowAstNode, minimum: number, maximum: number): void {
  const args = call.arguments ?? [];
  if (args.length < minimum || args.length > maximum || args.some((arg: WorkflowAstNode) => arg?.type === "SpreadElement")) {
    const method = memberPropertyName(call.callee) ?? "operation";
    const count = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
    throw new WorkflowScriptError(`flow.${method} requires ${count} non-spread argument(s)`, location(call));
  }
}

function staticString(node: WorkflowAstNode, label: string): string {
  if (node?.type !== "Literal" || typeof node.value !== "string") {
    throw new WorkflowScriptError(`${label} must be a static string`, location(node));
  }
  return node.value;
}

function assertProfileSelector(value: string, node: WorkflowAstNode, label: string): void {
  if (!PROFILE_SELECTOR.test(value)) throw new WorkflowScriptError(`Invalid ${label} ${value}`, location(node));
}

function assertFlowMethod(value: string, node: WorkflowAstNode): FlowMethod {
  if (!FLOW_METHOD_SET.has(value)) throw new WorkflowScriptError(`Unknown flow operation ${value}`, location(node));
  return value as FlowMethod;
}

function flowMethod(node: WorkflowAstNode, flowName: string): string | undefined {
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression"
    || node.callee.computed || node.callee.object?.type !== "Identifier"
    || node.callee.object.name !== flowName || node.callee.property?.type !== "Identifier") return undefined;
  return node.callee.property.name;
}

function isAwaitedOrReturned(input: AnalyzeWorkflowSourceInput, node: WorkflowAstNode): boolean {
  const entry = input.parents.get(node);
  if (!entry) return false;
  if (entry.parent.type === "AwaitExpression" && entry.key === "argument") return true;
  if (entry.parent.type === "ReturnStatement" && entry.key === "argument") return true;
  return entry.parent.type === "ArrowFunctionExpression" && entry.key === "body";
}

function lastBoundary(signature: ContextSignature, kind: ContextBoundaryKind): ContextBoundary | undefined {
  return [...signature].reverse().find((entry) => entry.kind === kind);
}

function lastBoundaryIndex(signature: ContextSignature, kind: ContextBoundaryKind): number {
  for (let index = signature.length - 1; index >= 0; index--) if (signature[index]!.kind === kind) return index;
  return -1;
}

function summarizeContexts(signatures: readonly ContextSignature[]): WorkflowExecutionContext[] {
  const values = new Set<WorkflowExecutionContext>();
  for (const signature of signatures) {
    if (signature.length === 0) values.add("root");
    for (const boundary of signature) values.add(boundary.kind);
  }
  return CONTEXT_ORDER.filter((context) => values.has(context));
}

function sameSignature(left: ContextSignature, right: ContextSignature): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.kind === right[index]!.kind && entry.root === right[index]!.root);
}

function topLevelBindings(ast: WorkflowAstNode): Set<string> {
  const result = new Set<string>();
  for (const statement of ast.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) if (specifier.local?.name) result.add(specifier.local.name);
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations ?? []) collectPatternNames(declaration.id, result);
    }
    if (statement.type === "FunctionDeclaration" && statement.id?.name) result.add(statement.id.name);
  }
  return result;
}

function isFunctionDeclarationIdentifier(
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): boolean {
  return Boolean(
    ((parent?.type === "FunctionDeclaration" || parent?.type === "FunctionExpression") && key === "id")
    || (parent?.type === "VariableDeclarator" && key === "id" && isFunction(parent.init))
    || isNoncomputedPropertyKey(node, parent, key),
  );
}

function isDeclarationIdentifier(
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): boolean {
  if (!parent) return false;
  if ((parent.type === "VariableDeclarator" && key === "id")
    || ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && key === "id")
    || (isFunction(parent) && key === "params")
    || (parent.type === "CatchClause" && key === "param")) return true;
  return ["RestElement", "AssignmentPattern", "ArrayPattern", "ObjectPattern"].includes(parent.type)
    && patternContainsNode(parent, node);
}

function isNoncomputedPropertyKey(
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): boolean {
  return parent?.type === "Property" && key === "key" && !parent.computed && parent.key === node;
}

function patternContainsNode(pattern: WorkflowAstNode, target: WorkflowAstNode): boolean {
  let found = false;
  walk(pattern, (node) => { if (node === target) { found = true; return false; } return found ? false : undefined; });
  return found;
}

function collectPatternNames(pattern: WorkflowAstNode | undefined, result: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") result.add(pattern.name);
  else if (pattern.type === "RestElement") collectPatternNames(pattern.argument, result);
  else if (pattern.type === "AssignmentPattern") collectPatternNames(pattern.left, result);
  else if (pattern.type === "ArrayPattern") for (const entry of pattern.elements ?? []) collectPatternNames(entry, result);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) collectPatternNames(property.value ?? property.argument, result);
  }
}

function walkOwn(node: WorkflowAstNode, visitor: (node: WorkflowAstNode) => void | false): void {
  walk(node, (child) => {
    if (child !== node && isFunction(child)) return false;
    return visitor(child);
  });
}

function isMutationNode(node: WorkflowAstNode): boolean {
  if (node?.type === "AssignmentExpression" || node?.type === "UpdateExpression") return true;
  if (node?.type === "UnaryExpression" && node.operator === "delete") return true;
  return node?.type === "CallExpression" && node.callee?.type === "MemberExpression"
    && MUTATING_METHODS.has(memberPropertyName(node.callee) ?? "");
}

function mutationTarget(node: WorkflowAstNode): WorkflowAstNode | undefined {
  if (node.type === "AssignmentExpression") return node.left;
  if (node.type === "UpdateExpression" || node.type === "UnaryExpression") return node.argument;
  if (node.type === "CallExpression") return node.callee.object;
  return undefined;
}

function mutatesReferencedValue(node: WorkflowAstNode): boolean {
  return node.type === "CallExpression" || node.type === "UnaryExpression"
    || (node.type === "AssignmentExpression" && node.left?.type !== "Identifier")
    || (node.type === "UpdateExpression" && node.argument?.type !== "Identifier");
}

function rootIdentifier(node: WorkflowAstNode | undefined): string | undefined {
  let current = node;
  while (current) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "ChainExpression") current = current.expression;
    else return undefined;
  }
  return undefined;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value) <= DEFINITION_LIMITS.projectSnapshotPathBytes
    && !value.startsWith("/") && !value.includes("\\") && !value.includes("//")
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareDynamicResources(left: WorkflowDynamicResourceUse, right: WorkflowDynamicResourceUse): number {
  return left.inputPath.localeCompare(right.inputPath) || left.operationSite.localeCompare(right.operationSite);
}
