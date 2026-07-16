import { WorkflowScriptError } from "../runtime/errors.js";
import type { JsonValue } from "../types.js";
import {
  type AgentSourceSelection,
  type CommandSourceSelection,
  type NamedProfileSourceSelection,
  type OperationSourceLocation,
  type StructuredWorkflowMetadata,
  type WorkflowCapability,
  type WorkflowReviewSummary,
} from "./types.js";
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
  validateDeterministicSource,
  validateDuplicateSiblingIds,
  validateRecursion,
} from "./workflow-source-restrictions.js";

export type CallbackKind =
  | "run-body"
  | "stage-body"
  | "loop-condition"
  | "loop-body"
  | "parallel-branch"
  | "fanout-key"
  | "fanout-body"
  | "candidate-body";

export interface WorkflowSourceContext {
  ast: WorkflowAstNode;
  definitionNode: WorkflowAstNode;
  runNode: WorkflowAstNode;
  flowName: string;
  argsName: string;
  metadata: StructuredWorkflowMetadata;
  constants: Map<string, WorkflowAstNode>;
  constantValues: Map<string, JsonValue>;
  parents: Map<WorkflowAstNode, { parent: WorkflowAstNode; key: string }>;
  callbacks: Map<WorkflowAstNode, CallbackKind>;
  operationCalls: Array<{ node: WorkflowAstNode; method: string; id: string }>;
  agentSelections: AgentSourceSelection[];
  commandSelections: CommandSourceSelection[];
  measurementSelections: NamedProfileSourceSelection[];
  verificationSelections: NamedProfileSourceSelection[];
  usedCapabilities: Set<WorkflowCapability>;
  usesCandidateWrites: boolean;
  usesMediatedNetwork: boolean;
  frozenAliases: Set<string>;
}

export interface WorkflowSourceAnalysis {
  operationLocations: OperationSourceLocation[];
  agentSelections: AgentSourceSelection[];
  commandSelections: CommandSourceSelection[];
  measurementSelections: NamedProfileSourceSelection[];
  verificationSelections: NamedProfileSourceSelection[];
  review: WorkflowReviewSummary;
}

export const FLOW_METHODS = new Set([
  "stage",
  "loop",
  "parallel",
  "fanOut",
  "agent",
  "command",
  "checkpoint",
  "metric",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
]);

export const PARALLEL_FORBIDDEN_METHODS = new Set([
  "checkpoint",
  "metric",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
]);

export const CANDIDATE_FORBIDDEN_METHODS = new Set([
  "checkpoint",
  "parallel",
  "fanOut",
  "metric",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
]);

const PROFILE_SELECTOR = /^(?:(?:builtin|user|project):)?[a-z][a-z0-9_-]{0,63}$/;

export function analyzeWorkflowSource(
  input: Omit<WorkflowSourceContext,
    | "callbacks"
    | "operationCalls"
    | "agentSelections"
    | "commandSelections"
    | "measurementSelections"
    | "verificationSelections"
    | "usedCapabilities"
    | "usesCandidateWrites"
    | "usesMediatedNetwork"
    | "frozenAliases"
  >,
): WorkflowSourceAnalysis {
  const context: WorkflowSourceContext = {
    ...input,
    callbacks: new Map([[input.runNode, "run-body"]]),
    operationCalls: [],
    agentSelections: [],
    commandSelections: [],
    measurementSelections: [],
    verificationSelections: [],
    usedCapabilities: new Set(),
    usesCandidateWrites: false,
    usesMediatedNetwork: false,
    frozenAliases: new Set(),
  };
  context.frozenAliases = collectBindingAliases(context.runNode.body, new Set([
    context.argsName,
    context.flowName,
    ...context.constants.keys(),
  ]));

  discoverOperationCallbacks(context);
  validateDeterministicSource(context);
  validateDuplicateSiblingIds(context);
  validateRecursion(context);

  const operationLocations = context.operationCalls.map(({ node, method, id }) => ({
    method,
    id,
    ...sourceLocation(node),
  }));
  const review: WorkflowReviewSummary = {
    capabilities: [...context.usedCapabilities].sort(),
    agentProfiles: uniqueProfiles(context.agentSelections),
    commandProfiles: uniqueProfiles(context.commandSelections),
    measurementProfiles: uniqueProfiles(context.measurementSelections),
    verificationProfiles: uniqueProfiles(context.verificationSelections),
    usesCandidateWrites: context.usesCandidateWrites,
    usesMediatedNetwork: context.usesMediatedNetwork,
    humanCheckpointCount: context.operationCalls.filter((call) => call.method === "checkpoint").length,
    applySiteCount: context.operationCalls.filter((call) => call.method === "apply").length,
  };
  return {
    operationLocations,
    agentSelections: copySelections(context.agentSelections),
    commandSelections: copySelections(context.commandSelections),
    measurementSelections: copySelections(context.measurementSelections),
    verificationSelections: copySelections(context.verificationSelections),
    review,
  };
}

function discoverOperationCallbacks(context: WorkflowSourceContext): void {
  walk(context.runNode.body, (node) => {
    const flowCall = getFlowCall(node, context.flowName);
    if (!flowCall) return;
    if (node.optional || node.callee?.optional) {
      throw new WorkflowScriptError("Flow operations may not use optional chaining", location(node));
    }
    const { method } = flowCall;
    if (!FLOW_METHODS.has(method)) throw new WorkflowScriptError(`Unknown flow operation ${method}`, location(node));
    const id = operationId(node, method);
    context.operationCalls.push({ node, method, id });

    switch (method) {
      case "stage":
        markFunctionArgument(context, node, 1, "stage-body");
        validateStaticOptions(node.arguments?.[2], new Set(["title"]), "stage options");
        break;
      case "loop":
        validateLoopSource(context, node);
        break;
      case "parallel":
        validateParallelSource(context, node);
        break;
      case "fanOut":
        validateFanOutSource(context, node);
        break;
      case "agent":
        validateAgentSource(context, node, id);
        break;
      case "command":
        validateCommandSource(context, node, id);
        break;
      case "checkpoint":
        validateCheckpointSource(node);
        break;
      case "metric":
        validateMetricSource(node);
        break;
      case "measure":
        validateMeasurementSource(context, node, id);
        break;
      case "candidate":
        markFunctionArgument(context, node, 1, "candidate-body");
        validateStaticOptions(node.arguments?.[2], new Set(["title", "base", "metadataSchema", "writes"]), "candidate options");
        break;
      case "verify":
        validateVerificationSource(context, node, id);
        break;
      case "accept":
        validateRequiredOptions(node, "accept options", ["candidate", "verification"], ["candidate", "verification", "measurement"]);
        break;
      case "reject":
        validateRequiredOptions(node, "reject options", ["candidate", "reason"], ["candidate", "reason", "measurement", "verification"]);
        break;
      case "recordExperiment":
        validateRequiredOptions(node, "recordExperiment options", ["candidate", "measurement", "learned"], ["candidate", "measurement", "learned"]);
        break;
      case "apply":
        validateRequiredOptions(node, "apply options", ["candidate", "verification"], ["candidate", "verification"]);
        break;
    }
  });
}

function validateLoopSource(context: WorkflowSourceContext, call: WorkflowAstNode): void {
  const options = requireObjectArgument(call, 1, "loop options");
  const properties = objectProperties(options, "loop options");
  assertOptionKeys(properties, new Set(["title", "maxIterations", "while", "until"]), "loop options");
  const maximum = properties.get("maxIterations");
  if (!maximum) throw new WorkflowScriptError("loop options require maxIterations", location(options));
  if (maximum.value?.type === "Literal") {
    if (
      !Number.isSafeInteger(maximum.value.value) ||
      maximum.value.value < 1 ||
      maximum.value.value > DEFINITION_LIMITS.loopIterations
    ) {
      throw new WorkflowScriptError(`loop maxIterations must be 1–${DEFINITION_LIMITS.loopIterations}`, location(maximum.value));
    }
  }
  const whileProperty = properties.get("while");
  const untilProperty = properties.get("until");
  if (Boolean(whileProperty) === Boolean(untilProperty)) {
    throw new WorkflowScriptError("loop requires exactly one of while or until", location(options));
  }
  const condition = (whileProperty ?? untilProperty)!.value;
  if (!isFunction(condition) || condition.async || condition.generator) {
    throw new WorkflowScriptError("loop condition must be a synchronous callback", location(condition));
  }
  context.callbacks.set(condition, "loop-condition");
  markFunctionArgument(context, call, 2, "loop-body");
}

function validateParallelSource(context: WorkflowSourceContext, call: WorkflowAstNode): void {
  const branches = requireObjectArgument(call, 1, "parallel branches");
  const properties = objectProperties(branches, "parallel branches");
  if (properties.size === 0 || properties.size > DEFINITION_LIMITS.parallelBranches) {
    throw new WorkflowScriptError(`parallel branch count must be 1–${DEFINITION_LIMITS.parallelBranches}`, location(branches));
  }
  for (const [key, property] of properties) {
    assertOperationId(key, property.key);
    if (!isFunction(property.value)) {
      throw new WorkflowScriptError(`parallel branch ${key} must be a callback`, location(property));
    }
    context.callbacks.set(property.value, "parallel-branch");
  }
  const options = call.arguments?.[2];
  validateStaticOptions(options, new Set(["title", "concurrency", "failure"]), "parallel options");
  validateRequestedConcurrency(context, options, "parallel");
}

function validateFanOutSource(context: WorkflowSourceContext, call: WorkflowAstNode): void {
  const options = requireObjectArgument(call, 2, "fanOut options");
  const properties = objectProperties(options, "fanOut options");
  assertOptionKeys(properties, new Set(["key", "title", "concurrency", "failure"]), "fanOut options");
  const key = properties.get("key")?.value;
  if (!key || !isFunction(key) || key.async || key.generator) {
    throw new WorkflowScriptError("fanOut options require a synchronous key callback", location(key ?? options));
  }
  context.callbacks.set(key, "fanout-key");
  markFunctionArgument(context, call, 3, "fanout-body");
  validateRequestedConcurrency(context, options, "fanOut");
}

function validateRequestedConcurrency(
  context: WorkflowSourceContext,
  options: WorkflowAstNode | undefined,
  label: string,
): void {
  if (options?.type !== "ObjectExpression") return;
  const concurrency = objectProperties(options, `${label} options`).get("concurrency")?.value;
  if (!concurrency || concurrency.type !== "Literal") return;
  if (!Number.isSafeInteger(concurrency.value) || concurrency.value < 1) {
    throw new WorkflowScriptError(`${label} concurrency must be a positive safe integer`, location(concurrency));
  }
  const ceiling = context.metadata.maxParallelism ?? DEFINITION_LIMITS.concurrency;
  if (concurrency.value > ceiling) {
    throw new WorkflowScriptError(`${label} concurrency ${concurrency.value} exceeds the workflow ceiling ${ceiling}`, location(concurrency));
  }
}

function validateAgentSource(context: WorkflowSourceContext, call: WorkflowAstNode, id: string): void {
  const options = requireObjectArgument(call, 1, "agent options");
  const properties = objectProperties(options, "agent options");
  assertOptionKeys(
    properties,
    new Set(["title", "profile", "prompt", "inputs", "outputSchema", "workspace", "network", "resultMode"]),
    "agent options",
  );
  for (const required of ["profile", "prompt"]) {
    if (!properties.has(required)) throw new WorkflowScriptError(`agent options require ${required}`, location(options));
  }
  const profile = requiredProfileOption(properties, "profile", "agent profile");
  const network = staticStringOption(properties, "network", "agent network") ?? "none";
  if (network !== "none" && network !== "research") {
    throw new WorkflowScriptError("agent network must be a static none or research literal", location(properties.get("network")?.value));
  }
  const resultMode = staticStringOption(properties, "resultMode", "agent resultMode") ?? "value";
  if (!["value", "artifact", "value-and-artifact"].includes(resultMode)) {
    throw new WorkflowScriptError(
      "agent resultMode must be a static value, artifact, or value-and-artifact literal",
      location(properties.get("resultMode")?.value),
    );
  }
  const workspace = properties.has("workspace") ? "candidate" : "snapshot";
  context.agentSelections.push({
    id,
    profile,
    workspace,
    network: network as "none" | "research",
    resultMode: resultMode as "value" | "artifact" | "value-and-artifact",
    location: sourceLocation(call),
  });
}

function validateCommandSource(context: WorkflowSourceContext, call: WorkflowAstNode, id: string): void {
  const options = requireObjectArgument(call, 1, "command options");
  const properties = objectProperties(options, "command options");
  assertOptionKeys(
    properties,
    new Set(["title", "profile", "args", "effect", "workspace", "output", "allowFailure"]),
    "command options",
  );
  if (!properties.has("profile")) throw new WorkflowScriptError("command options require profile", location(options));
  const profile = requiredProfileOption(properties, "profile", "command profile");
  const effect = staticStringOption(properties, "effect", "command effect") ?? "read-only";
  if (!["read-only", "temporary", "candidate"].includes(effect)) {
    throw new WorkflowScriptError(
      "command effect must be a static read-only, temporary, or candidate literal",
      location(properties.get("effect")?.value),
    );
  }
  if (effect === "candidate" && !properties.has("workspace")) {
    throw new WorkflowScriptError("candidate commands require a workspace", location(options));
  }
  if (effect !== "candidate" && properties.has("workspace")) {
    throw new WorkflowScriptError("command workspace is only valid for candidate effects", location(properties.get("workspace")));
  }
  const output = staticStringOption(properties, "output", "command output");
  if (output !== undefined && !["summary", "stdout", "json"].includes(output)) {
    throw new WorkflowScriptError("command output must be a static summary, stdout, or json literal", location(properties.get("output")?.value));
  }
  context.commandSelections.push({
    id,
    profile,
    effect: effect as "read-only" | "temporary" | "candidate",
    location: sourceLocation(call),
  });
}

function validateMeasurementSource(context: WorkflowSourceContext, call: WorkflowAstNode, id: string): void {
  const options = requireObjectArgument(call, 1, "measure options");
  const properties = objectProperties(options, "measure options");
  assertOptionKeys(properties, new Set(["title", "metric", "metrics", "measurement", "output", "workspace"]), "measure options");
  if (!properties.has("measurement")) throw new WorkflowScriptError("measure options require measurement", location(options));
  if (properties.has("metric") === properties.has("metrics")) {
    throw new WorkflowScriptError("measure options require exactly one of metric or metrics", location(options));
  }
  const profile = requiredProfileOption(properties, "measurement", "measurement profile");
  context.measurementSelections.push({ id, profile, location: sourceLocation(call) });
}

function validateVerificationSource(context: WorkflowSourceContext, call: WorkflowAstNode, id: string): void {
  const options = requireObjectArgument(call, 1, "verify options");
  const properties = objectProperties(options, "verify options");
  assertOptionKeys(properties, new Set(["title", "candidate", "profile"]), "verify options");
  for (const required of ["candidate", "profile"]) {
    if (!properties.has(required)) throw new WorkflowScriptError(`verify options require ${required}`, location(options));
  }
  const profile = requiredProfileOption(properties, "profile", "verification profile");
  context.verificationSelections.push({ id, profile, location: sourceLocation(call) });
}

function validateCheckpointSource(call: WorkflowAstNode): void {
  const options = requireObjectArgument(call, 1, "checkpoint options");
  const properties = objectProperties(options, "checkpoint options");
  const kindNode = properties.get("kind")?.value;
  if (kindNode?.type !== "Literal" || !["confirm", "choice", "input"].includes(kindNode.value)) {
    throw new WorkflowScriptError("checkpoint kind must be a static confirm, choice, or input literal", location(kindNode ?? options));
  }
  const kind = kindNode.value as "confirm" | "choice" | "input";
  const allowed = new Set(["kind", "title", "prompt"]);
  if (kind === "choice") allowed.add("choices");
  if (kind === "input") allowed.add("responseSchema");
  assertOptionKeys(properties, allowed, "checkpoint options");
  if (!properties.has("prompt")) throw new WorkflowScriptError("checkpoint options require prompt", location(options));
  if (kind === "choice" && !properties.has("choices")) {
    throw new WorkflowScriptError("choice checkpoints require choices", location(options));
  }
  if (kind === "input" && !properties.has("responseSchema")) {
    throw new WorkflowScriptError("input checkpoints require responseSchema", location(options));
  }

  const choices = properties.get("choices")?.value;
  if (kind !== "choice" || choices?.type !== "ArrayExpression") return;
  if (choices.elements.length === 0 || choices.elements.length > DEFINITION_LIMITS.checkpointChoices) {
    throw new WorkflowScriptError(
      `checkpoint choices must contain 1–${DEFINITION_LIMITS.checkpointChoices} entries`,
      location(choices),
    );
  }
  const ids = new Set<string>();
  for (const entry of choices.elements) {
    if (!entry || entry.type !== "ObjectExpression") continue;
    const choice = objectProperties(entry, "checkpoint choice");
    assertOptionKeys(choice, new Set(["id", "label"]), "checkpoint choice");
    const choiceId = choice.get("id")?.value;
    if (choiceId?.type === "Literal" && typeof choiceId.value === "string") {
      assertOperationId(choiceId.value, choiceId);
      if (ids.has(choiceId.value)) {
        throw new WorkflowScriptError(`Duplicate checkpoint choice id ${choiceId.value}`, location(choiceId));
      }
      ids.add(choiceId.value);
    }
  }
}

function validateMetricSource(call: WorkflowAstNode): void {
  const definition = requireObjectArgument(call, 1, "metric definition");
  const properties = objectProperties(definition, "metric definition");
  assertOptionKeys(
    properties,
    new Set(["title", "direction", "unit", "primary", "format", "target", "sampling", "improvement", "guardrail"]),
    "metric definition",
  );
  if (!properties.has("direction")) throw new WorkflowScriptError("metric definition requires direction", location(definition));
}

function validateRequiredOptions(
  call: WorkflowAstNode,
  label: string,
  required: readonly string[],
  allowed: readonly string[],
): void {
  const options = requireObjectArgument(call, 1, label);
  const properties = objectProperties(options, label);
  assertOptionKeys(properties, new Set(allowed), label);
  for (const key of required) {
    if (!properties.has(key)) throw new WorkflowScriptError(`${label} require ${key}`, location(options));
  }
}

function validateStaticOptions(node: WorkflowAstNode | undefined, allowed: Set<string>, label: string): void {
  if (node === undefined) return;
  if (node.type !== "ObjectExpression") throw new WorkflowScriptError(`${label} must be an object literal`, location(node));
  assertOptionKeys(objectProperties(node, label), allowed, label);
}

function assertOptionKeys(properties: Map<string, WorkflowAstNode>, allowed: Set<string>, label: string): void {
  for (const [key, property] of properties) {
    if (!allowed.has(key)) throw new WorkflowScriptError(`${label} contains unknown field ${key}`, location(property));
  }
}

function requiredProfileOption(properties: Map<string, WorkflowAstNode>, key: string, label: string): string {
  const value = staticStringOption(properties, key, label);
  if (!value || !PROFILE_SELECTOR.test(value)) {
    throw new WorkflowScriptError(`${label} must be a static registered profile literal`, location(properties.get(key)?.value));
  }
  return value;
}

function staticStringOption(
  properties: Map<string, WorkflowAstNode>,
  key: string,
  label: string,
): string | undefined {
  const property = properties.get(key);
  if (!property) return undefined;
  if (property.value?.type !== "Literal" || typeof property.value.value !== "string") {
    throw new WorkflowScriptError(`${label} must be a static string literal`, location(property.value));
  }
  return property.value.value;
}

function operationId(call: WorkflowAstNode, method: string): string {
  const argument = call.arguments?.[0];
  if (argument?.type !== "Literal" || typeof argument.value !== "string") {
    throw new WorkflowScriptError(`flow.${method}() requires a literal stable operation id`, location(argument ?? call));
  }
  assertOperationId(argument.value, argument);
  return argument.value;
}

function assertOperationId(value: string, node?: WorkflowAstNode): void {
  if (!FLOW_NAME_PATTERN.test(value)) {
    throw new WorkflowScriptError(`Operation id must match ${FLOW_NAME_PATTERN.source}: ${value}`, location(node));
  }
}

function markFunctionArgument(
  context: WorkflowSourceContext,
  call: WorkflowAstNode,
  index: number,
  kind: CallbackKind,
): void {
  const argument = call.arguments?.[index];
  if (!argument || !isFunction(argument)) {
    throw new WorkflowScriptError(
      `flow.${memberPropertyName(call.callee)}() argument ${index + 1} must be a callback`,
      location(argument ?? call),
    );
  }
  context.callbacks.set(argument, kind);
}

function requireObjectArgument(call: WorkflowAstNode, index: number, label: string): WorkflowAstNode {
  const argument = call.arguments?.[index];
  if (!argument || argument.type !== "ObjectExpression") {
    throw new WorkflowScriptError(`${label} must be an object literal`, location(argument ?? call));
  }
  return argument;
}

export function getFlowCall(node: WorkflowAstNode, flowName: string): { method: string } | undefined {
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return undefined;
  if (node.callee.object?.type !== "Identifier" || node.callee.object.name !== flowName) return undefined;
  const method = memberPropertyName(node.callee);
  return method ? { method } : undefined;
}

export function hasStaticOption(options: WorkflowAstNode | undefined, key: string): boolean {
  if (options?.type !== "ObjectExpression") return false;
  return options.properties.some(
    (property: WorkflowAstNode) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === key) ||
        (property.key.type === "Literal" && property.key.value === key)),
  );
}

export function staticOptionLiteral(options: WorkflowAstNode | undefined, key: string): unknown {
  if (options?.type !== "ObjectExpression") return undefined;
  const property = options.properties.find(
    (candidate: WorkflowAstNode) =>
      candidate.type === "Property" &&
      !candidate.computed &&
      ((candidate.key.type === "Identifier" && candidate.key.name === key) ||
        (candidate.key.type === "Literal" && candidate.key.value === key)),
  );
  return property?.value?.type === "Literal" ? property.value.value : undefined;
}

function collectBindingAliases(node: WorkflowAstNode, roots: Set<string>): Set<string> {
  const aliases = new Set<string>(roots);
  const assignments: Array<{ targets: string[]; source?: string }> = [];
  walk(node, (child) => {
    if (child.type === "VariableDeclarator") {
      const targets = new Set<string>();
      collectPatternNames(child.id, targets);
      assignments.push({ targets: [...targets], source: rootIdentifier(child.init) });
    }
    if (child.type === "AssignmentExpression" && child.operator === "=") {
      const targets = new Set<string>();
      collectPatternNames(child.left, targets);
      assignments.push({ targets: [...targets], source: rootIdentifier(child.right) });
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (!assignment.source || !aliases.has(assignment.source)) continue;
      for (const target of assignment.targets) {
        if (aliases.has(target)) continue;
        aliases.add(target);
        changed = true;
      }
    }
  }
  for (const root of roots) aliases.delete(root);
  return aliases;
}

function collectPatternNames(pattern: WorkflowAstNode | undefined, result: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") result.add(pattern.name);
  else if (pattern.type === "RestElement") collectPatternNames(pattern.argument, result);
  else if (pattern.type === "AssignmentPattern") collectPatternNames(pattern.left, result);
  else if (pattern.type === "ArrayPattern") {
    for (const entry of pattern.elements) collectPatternNames(entry, result);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) collectPatternNames(property.value ?? property.argument, result);
  }
}

function rootIdentifier(node: WorkflowAstNode | undefined): string | undefined {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "ChainExpression") {
    current = current.type === "ChainExpression" ? current.expression : current.object;
  }
  return current?.type === "Identifier" ? current.name : undefined;
}

function uniqueProfiles(selections: readonly { profile: string }[]): string[] {
  return [...new Set(selections.map((selection) => selection.profile))].sort();
}

function copySelections<T extends { location: { line: number; column: number } }>(selections: readonly T[]): T[] {
  return selections.map((selection) => ({ ...selection, location: { ...selection.location } }));
}
