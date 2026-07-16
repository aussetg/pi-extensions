import { WorkflowScriptError } from "../runtime/errors.js";
import { DEFINITION_LIMITS } from "./limits.js";
import type { WorkflowCapability } from "./types.js";
import {
  isFunction,
  location,
  memberPropertyName,
  walk,
  type WorkflowAstNode,
} from "./workflow-ast.js";
import {
  CANDIDATE_FORBIDDEN_METHODS,
  FLOW_METHODS,
  PARALLEL_FORBIDDEN_METHODS,
  getFlowCall,
  hasStaticOption,
  staticOptionLiteral,
  type WorkflowSourceContext,
} from "./workflow-source-analysis.js";

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
const CAPTURE_BOUNDARY_CALLBACKS = new Set(["parallel-branch", "fanout-body", "candidate-body"]);

const REQUIRED_CAPABILITIES: Partial<Record<string, WorkflowCapability[]>> = {
  agent: ["read-project"],
  command: ["host-command"],
  checkpoint: ["human-input"],
  measure: ["host-command"],
  candidate: ["candidate-write"],
  verify: ["candidate-write"],
  accept: ["candidate-write"],
  reject: ["candidate-write"],
  recordExperiment: ["candidate-write"],
  apply: ["candidate-write", "human-input"],
};

export function validateDeterministicSource(context: WorkflowSourceContext): void {
  const topFunctionNodes = new Set<WorkflowAstNode>(
    context.ast.body.filter((node: WorkflowAstNode) => node.type === "FunctionDeclaration"),
  );
  const authorizedEffectFunctions = new Set<WorkflowAstNode>([
    context.runNode,
    ...[...context.callbacks.entries()]
      .filter(([, kind]) => kind !== "loop-condition" && kind !== "fanout-key")
      .map(([node]) => node),
  ]);

  walk(context.ast, (node, parent, key) => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      throw new WorkflowScriptError("Workflow definitions may not import modules", location(node));
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      throw new WorkflowScriptError("Only the default defineWorkflow export is allowed", location(node));
    }
    if (node.type === "MetaProperty") throw new WorkflowScriptError("import.meta is unavailable", location(node));
    if (["WhileStatement", "DoWhileStatement", "ForInStatement"].includes(node.type)) {
      throw new WorkflowScriptError("Unbounded loops are forbidden; use flow.loop()", location(node));
    }
    if (node.type === "ForStatement") validateBoundedFor(node, context);
    if (node.type === "ForOfStatement") validateBoundedForOf(node, context);
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      throw new WorkflowScriptError("Classes are unavailable in deterministic workflow control", location(node));
    }
    if (node.type === "ThisExpression" || node.type === "Super") {
      throw new WorkflowScriptError("this/super are unavailable in workflow control", location(node));
    }
    if (node.type === "YieldExpression") throw new WorkflowScriptError("Generators are unavailable in workflow control", location(node));

    if (node.type === "Identifier") validateIdentifier(context, node, parent, key);
    if (node.type === "MemberExpression") validateMember(context, node, parent, key);
    if (node.type === "NewExpression" && node.callee?.type === "Identifier" && ["Function", "Promise", "Date"].includes(node.callee.name)) {
      throw new WorkflowScriptError(`new ${node.callee.name}() is unavailable in workflow control`, location(node));
    }
    if (node.type === "CallExpression") validateCall(context, node, authorizedEffectFunctions);
    if (isMutationNode(node)) validateMutation(context, node);
  });

  for (const [callback, kind] of context.callbacks) {
    if (kind === "loop-condition" || kind === "fanout-key") validatePureCallback(context, callback, kind);
    if (kind === "parallel-branch" || kind === "fanout-body" || kind === "candidate-body") {
      validateNoCapturedMutation(context, callback, kind);
    }
  }
  for (const fn of topFunctionNodes) {
    if (containsFlowCall(fn.body, context.flowName)) {
      throw new WorkflowScriptError("Top-level helpers must be pure and may not execute flow operations", location(fn));
    }
  }
}

function validateIdentifier(
  context: WorkflowSourceContext,
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): void {
  if (node.name.startsWith("__flow") && !isNonComputedPropertyKey(node, parent, key)) {
    throw new WorkflowScriptError(`Reserved workflow binding: ${node.name}`, location(node));
  }
  if (isDeclarationIdentifier(node, parent, key)) {
    if (
      node.name === "defineWorkflow" ||
      node.name.startsWith("__flow") ||
      ((node.name === context.flowName || node.name === context.argsName) &&
        node !== context.runNode.params[0] && node !== context.runNode.params[1]) ||
      ((FORBIDDEN_IDENTIFIERS.has(node.name) || AMBIENT_TIME_IDENTIFIERS.has(node.name)) &&
        isTopLevelBinding(context, node))
    ) {
      throw new WorkflowScriptError(`Reserved workflow binding: ${node.name}`, location(node));
    }
    return;
  }
  if (isNonComputedPropertyKey(node, parent, key)) return;
  if (node.name === "defineWorkflow" && !isDefinitionCallee(context, parent, key)) {
    throw new WorkflowScriptError("defineWorkflow is available only for the default definition", location(node));
  }
  if (node.name === context.flowName && !(parent?.type === "MemberExpression" && key === "object")) {
    throw new WorkflowScriptError("The flow API may not be aliased or passed as a value", location(node));
  }
  if (
    node.name === "Math" &&
    !isLexicallyBound(context, node, node.name) &&
    !(parent?.type === "MemberExpression" && key === "object" && !parent.computed)
  ) {
    throw new WorkflowScriptError("Ambient Math may only be used through a static deterministic method", location(node));
  }
  if (FORBIDDEN_IDENTIFIERS.has(node.name) && !isLexicallyBound(context, node, node.name)) {
    throw new WorkflowScriptError(`Forbidden ambient API: ${node.name}`, location(node));
  }
  if (AMBIENT_TIME_IDENTIFIERS.has(node.name) && !isLexicallyBound(context, node, node.name)) {
    throw new WorkflowScriptError("Ambient time is unavailable in workflow control", location(node));
  }
}

function validateMember(
  context: WorkflowSourceContext,
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): void {
  const property = memberPropertyName(node);
  if (node.optional && node.object?.type === "Identifier" && node.object.name === context.flowName) {
    throw new WorkflowScriptError("The flow API may not use optional chaining", location(node));
  }
  if (property && FORBIDDEN_PROPERTIES.has(property)) {
    throw new WorkflowScriptError(`Forbidden property access: ${property}`, location(node));
  }
  if (
    node.object?.type === "Identifier" &&
    node.object.name === "Math" &&
    node.computed &&
    !isLexicallyBound(context, node.object, "Math")
  ) {
    throw new WorkflowScriptError("Ambient Math properties must use static access", location(node));
  }
  if (isMember(node, "Math", "random")) throw new WorkflowScriptError("Math.random() is unavailable", location(node));
  if (node.object?.type !== "Identifier" || node.object.name !== context.flowName) return;
  if (node.computed) throw new WorkflowScriptError("flow methods must use static property access", location(node));
  if (property !== "snapshot" && (!property || !FLOW_METHODS.has(property))) {
    throw new WorkflowScriptError(`Unknown flow API member ${property ?? "<computed>"}`, location(node));
  }
  if (property && FLOW_METHODS.has(property) && !(parent?.type === "CallExpression" && key === "callee")) {
    throw new WorkflowScriptError("Flow operation methods may not be aliased or passed as values", location(node));
  }
  if (property === "snapshot") {
    requireCapability(context, "candidate-write", node, "flow.snapshot");
    context.usesCandidateWrites = true;
  }
}

function validateCall(
  context: WorkflowSourceContext,
  node: WorkflowAstNode,
  authorizedEffectFunctions: Set<WorkflowAstNode>,
): void {
  if (node.callee?.type === "Identifier" && ["eval", "Function", "Date"].includes(node.callee.name)) {
    throw new WorkflowScriptError(`Forbidden call ${node.callee.name}()`, location(node));
  }
  if (node.callee?.type === "MemberExpression" && node.callee.object?.type === "Identifier" && node.callee.object.name === "Promise") {
    throw new WorkflowScriptError("Direct Promise concurrency is forbidden; use keyed flow.parallel()/flow.fanOut()", location(node));
  }
  if (
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    ["Object", "Reflect"].includes(node.callee.object.name) &&
    ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(memberPropertyName(node.callee) ?? "")
  ) {
    throw new WorkflowScriptError("Reflective mutation is unavailable in workflow control", location(node));
  }
  const flowCall = getFlowCall(node, context.flowName);
  if (flowCall) validateFlowCallContext(context, node, flowCall.method, authorizedEffectFunctions);
}

function validateFlowCallContext(
  context: WorkflowSourceContext,
  node: WorkflowAstNode,
  method: string,
  authorizedEffectFunctions: Set<WorkflowAstNode>,
): void {
  if (!FLOW_METHODS.has(method)) throw new WorkflowScriptError(`Unknown flow method ${method}`, location(node));
  if (method !== "metric" && !isAwaitedOrReturnedOperation(context, node)) {
    throw new WorkflowScriptError(`flow.${method}() must be directly awaited or returned`, location(node));
  }
  const nearestFunction = nearestAncestorFunction(context, node);
  if (!nearestFunction || !authorizedEffectFunctions.has(nearestFunction)) {
    throw new WorkflowScriptError("Flow operations may run only directly in run() or a semantic scope callback", location(node));
  }
  for (const capability of REQUIRED_CAPABILITIES[method] ?? []) {
    requireCapability(context, capability, node, `flow.${method}`);
  }

  if (method === "agent") {
    const network = staticOptionLiteral(node.arguments?.[1], "network");
    if (network === "research") {
      requireCapability(context, "mediated-network", node, "agent network: research");
      context.usesMediatedNetwork = true;
    }
    if (hasStaticOption(node.arguments?.[1], "workspace")) {
      requireCapability(context, "candidate-write", node, "candidate workspace agent");
      context.usesCandidateWrites = true;
      if (!insideCallback(context, node, "candidate-body")) {
        throw new WorkflowScriptError("candidate workspace agents may execute only inside candidate callbacks", location(node));
      }
    }
  }
  if (method === "command" && staticOptionLiteral(node.arguments?.[1], "effect") === "candidate") {
    requireCapability(context, "candidate-write", node, "candidate command");
    context.usesCandidateWrites = true;
    if (!insideCallback(context, node, "candidate-body")) {
      throw new WorkflowScriptError("candidate commands may execute only inside candidate callbacks", location(node));
    }
  }
  if (method === "measure" && hasStaticOption(node.arguments?.[1], "workspace")) {
    requireCapability(context, "candidate-write", node, "candidate measurement");
    context.usesCandidateWrites = true;
  }
  if (["candidate", "verify", "accept", "reject", "recordExperiment", "apply"].includes(method)) {
    context.usesCandidateWrites = true;
  }

  for (const ancestor of functionAncestors(context, node)) {
    const kind = context.callbacks.get(ancestor);
    if ((kind === "parallel-branch" || kind === "fanout-body") && PARALLEL_FORBIDDEN_METHODS.has(method)) {
      throw new WorkflowScriptError(`flow.${method} is unavailable inside read-only parallel/fanOut branches`, location(node));
    }
    if (
      (kind === "parallel-branch" || kind === "fanout-body") &&
      method === "command" &&
      staticOptionLiteral(node.arguments?.[1], "effect") === "candidate"
    ) {
      throw new WorkflowScriptError("Candidate commands are unavailable inside parallel/fanOut branches", location(node));
    }
    if (kind === "candidate-body" && CANDIDATE_FORBIDDEN_METHODS.has(method)) {
      throw new WorkflowScriptError(`flow.${method} is unavailable inside candidate callbacks`, location(node));
    }
    if (kind === "candidate-body" && method === "agent" && !hasStaticOption(node.arguments?.[1], "workspace")) {
      throw new WorkflowScriptError("flow.agent inside candidate callbacks requires the candidate workspace", location(node));
    }
    if (
      kind === "candidate-body" &&
      method === "command" &&
      (staticOptionLiteral(node.arguments?.[1], "effect") !== "candidate" || !hasStaticOption(node.arguments?.[1], "workspace"))
    ) {
      throw new WorkflowScriptError("flow.command inside candidate callbacks requires a candidate effect and workspace", location(node));
    }
    if ((kind === "loop-condition" || kind === "fanout-key") && FLOW_METHODS.has(method)) {
      throw new WorkflowScriptError(`${kind} callbacks must be pure`, location(node));
    }
  }
}

function requireCapability(
  context: WorkflowSourceContext,
  capability: WorkflowCapability,
  node: WorkflowAstNode,
  authority: string,
): void {
  if (!context.metadata.capabilities.includes(capability)) {
    throw new WorkflowScriptError(`${authority} requires declared capability ${capability}`, location(node));
  }
  context.usedCapabilities.add(capability);
}

function validateBoundedFor(node: WorkflowAstNode, context: WorkflowSourceContext): void {
  if (containsFlowCall(node.body, context.flowName)) {
    throw new WorkflowScriptError("for loops may prepare local data only; effects require flow.loop()/flow.fanOut()", location(node));
  }
  const declaration = node.init;
  const test = node.test;
  const update = node.update;
  if (
    declaration?.type !== "VariableDeclaration" || declaration.kind !== "let" || declaration.declarations.length !== 1 ||
    declaration.declarations[0]?.id?.type !== "Identifier" || declaration.declarations[0]?.init?.type !== "Literal" ||
    declaration.declarations[0].init.value !== 0 || test?.type !== "BinaryExpression" || !["<", "<="].includes(test.operator) ||
    test.left?.type !== "Identifier" || test.left.name !== declaration.declarations[0].id.name || test.right?.type !== "Literal" ||
    !Number.isSafeInteger(test.right.value) || test.right.value < 0 || test.right.value > DEFINITION_LIMITS.localLoopIterations ||
    update?.type !== "UpdateExpression" || update.operator !== "++" || update.argument?.type !== "Identifier" ||
    update.argument.name !== declaration.declarations[0].id.name
  ) {
    throw new WorkflowScriptError(
      `Local for loops require a literal bound ≤ ${DEFINITION_LIMITS.localLoopIterations}; effectful iteration uses flow.loop()`,
      location(node),
    );
  }
  const counter = declaration.declarations[0].id.name;
  if (writesBinding(node.body, counter)) {
    throw new WorkflowScriptError(`Local for loop counter ${counter} may not be modified by its body`, location(node.body));
  }
}

function validateBoundedForOf(node: WorkflowAstNode, context: WorkflowSourceContext): void {
  if (node.await) throw new WorkflowScriptError("for await is unavailable", location(node));
  if (containsFlowCall(node.body, context.flowName)) {
    throw new WorkflowScriptError("for…of may prepare local data only; effectful iteration uses flow.fanOut()/flow.loop()", location(node));
  }
  if (node.right?.type === "ArrayExpression" && node.right.elements.length <= DEFINITION_LIMITS.localLoopIterations) return;
  if (node.right?.type === "Identifier") {
    const value = context.constantValues.get(node.right.name);
    if (Array.isArray(value) && value.length <= DEFINITION_LIMITS.localLoopIterations) return;
  }
  if (isSchemaBoundedArgsArray(node.right, context)) return;
  throw new WorkflowScriptError("for…of requires a literal, frozen constant, or schema-bounded argument array", location(node.right));
}

function isSchemaBoundedArgsArray(node: WorkflowAstNode, context: WorkflowSourceContext): boolean {
  const segments: string[] = [];
  let current = node;
  while (current?.type === "MemberExpression" && !current.optional) {
    const property = memberPropertyName(current);
    if (!property) return false;
    segments.unshift(property);
    current = current.object;
  }
  if (current?.type !== "Identifier" || current.name !== context.argsName || segments.length === 0) return false;
  let schema: any = context.metadata.inputSchema;
  for (const segment of segments) schema = schema?.properties?.[segment];
  return schema?.type === "array" && Number.isSafeInteger(schema.maxItems) && schema.maxItems <= DEFINITION_LIMITS.localLoopIterations;
}

function validatePureCallback(context: WorkflowSourceContext, callback: WorkflowAstNode, kind: string): void {
  walk(callback.body, (node) => {
    if (isFunction(node) && context.callbacks.has(node)) return false;
    if (getFlowCall(node, context.flowName)) throw new WorkflowScriptError(`${kind} callback may not execute effects`, location(node));
    if (isMutationNode(node)) throw new WorkflowScriptError(`${kind} callback may not mutate state`, location(node));
    if (kind === "fanout-key" && node.type === "CallExpression") {
      throw new WorkflowScriptError("fanOut key callbacks may only derive a key from item data", location(node));
    }
    return undefined;
  });
}

function validateNoCapturedMutation(
  context: WorkflowSourceContext,
  callback: WorkflowAstNode,
  kind: string,
): void {
  const local = collectCaptureBoundaryNames(context, callback);
  const capturedAliases = collectCapturedAliases(context, callback, local);
  const ownNames = new Map<WorkflowAstNode, Set<string>>();
  const isLocal = (node: WorkflowAstNode, name: string): boolean =>
    bindingBelongsToCaptureBoundary(context, callback, node, name, ownNames);
  walkCaptureBoundary(context, callback, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && !isLocal(node.callee, node.callee.name)) {
      throw new WorkflowScriptError(`${kind} callback may not invoke captured helper ${node.callee.name}`, location(node));
    }
    if (!isMutationNode(node)) return;
    const target = mutationTarget(node);
    const root = rootIdentifier(target);
    const captured = root
      ? !isLocal(target!, root) || (capturedAliases.has(root) && mutatesReferencedValue(node))
      : mutatesReferencedValue(node) && aliasesCapturedValue(target, local, capturedAliases);
    if (captured) {
      throw new WorkflowScriptError(
        root
          ? `${kind} callback may not mutate captured binding ${root}`
          : `${kind} callback may not mutate state returned by a call`,
        location(node),
      );
    }
    return undefined;
  });
}

function bindingBelongsToCaptureBoundary(
  context: WorkflowSourceContext,
  callback: WorkflowAstNode,
  node: WorkflowAstNode,
  name: string,
  cache: Map<WorkflowAstNode, Set<string>>,
): boolean {
  for (const fn of functionAncestors(context, node)) {
    let names = cache.get(fn);
    if (!names) {
      names = collectOwnFunctionNames(fn);
      cache.set(fn, names);
    }
    if (names.has(name)) return true;
    if (fn === callback) return false;
  }
  return false;
}

function collectOwnFunctionNames(fn: WorkflowAstNode): Set<string> {
  const result = functionParameterNames(fn);
  if (fn.id?.name) result.add(fn.id.name);
  walk(fn.body, (node) => {
    if (isFunction(node)) {
      if (node.type === "FunctionDeclaration" && node.id?.name) result.add(node.id.name);
      return false;
    }
    if (node.type === "VariableDeclarator") collectPatternNames(node.id, result);
    if (node.type === "CatchClause" && node.param) collectPatternNames(node.param, result);
    return undefined;
  });
  return result;
}

function collectCapturedAliases(
  context: WorkflowSourceContext,
  callback: WorkflowAstNode,
  local: Set<string>,
): Set<string> {
  const aliases = new Set<string>();
  const assignments: Array<{ targets: string[]; source?: WorkflowAstNode }> = [];
  walkCaptureBoundary(context, callback, (node) => {
    if (node.type === "VariableDeclarator") {
      const targets = new Set<string>();
      collectPatternNames(node.id, targets);
      assignments.push({ targets: [...targets], source: node.init });
    }
    if (node.type === "AssignmentExpression" && node.operator === "=" && node.left?.type === "Identifier") {
      assignments.push({ targets: [node.left.name], source: node.right });
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (!aliasesCapturedValue(assignment.source, local, aliases)) continue;
      for (const target of assignment.targets) {
        if (!aliases.has(target)) { aliases.add(target); changed = true; }
      }
    }
  }
  return aliases;
}

function aliasesCapturedValue(
  node: WorkflowAstNode | undefined,
  local: Set<string>,
  aliases: Set<string>,
): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return !local.has(node.name) || aliases.has(node.name);
  if (node.type === "MemberExpression") return aliasesCapturedValue(node.object, local, aliases);
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return aliasesCapturedValue(node.expression ?? node.argument, local, aliases);
  }
  if (node.type === "AssignmentExpression") return aliasesCapturedValue(node.right, local, aliases);
  if (node.type === "ConditionalExpression") {
    return aliasesCapturedValue(node.consequent, local, aliases)
      || aliasesCapturedValue(node.alternate, local, aliases);
  }
  if (node.type === "LogicalExpression") {
    return aliasesCapturedValue(node.left, local, aliases)
      || aliasesCapturedValue(node.right, local, aliases);
  }
  if (node.type === "SequenceExpression") {
    return aliasesCapturedValue(node.expressions.at(-1), local, aliases);
  }
  // A call can return one of its inputs or closed-over state. Without a type or
  // effect system there is no sound local proof that the result is fresh, so a
  // capture-constrained callback may read it but may not mutate through it.
  return node.type === "CallExpression";
}

function collectCaptureBoundaryNames(
  context: WorkflowSourceContext,
  callback: WorkflowAstNode,
): Set<string> {
  const result = functionParameterNames(callback);
  if (callback.id?.name) result.add(callback.id.name);
  walkCaptureBoundary(context, callback, (node) => {
    if (node.type === "VariableDeclarator") collectPatternNames(node.id, result);
    if (node.type === "FunctionDeclaration" && node.id) result.add(node.id.name);
    if (node.type === "CatchClause" && node.param) collectPatternNames(node.param, result);
    return undefined;
  });
  return result;
}

function walkCaptureBoundary(
  context: WorkflowSourceContext,
  callback: WorkflowAstNode,
  visitor: (node: WorkflowAstNode) => void | false,
): void {
  walk(callback.body, (node) => {
    const nestedKind = isFunction(node) ? context.callbacks.get(node) : undefined;
    if (nestedKind && CAPTURE_BOUNDARY_CALLBACKS.has(nestedKind)) return false;
    return visitor(node);
  });
}

function validateMutation(context: WorkflowSourceContext, node: WorkflowAstNode): void {
  const root = rootIdentifier(mutationTarget(node));
  if (!root) return;
  if (context.constants.has(root)) throw new WorkflowScriptError(`Top-level data ${root} is frozen`, location(node));
  if (root === context.argsName || context.frozenAliases.has(root)) {
    throw new WorkflowScriptError("Invocation and host values are frozen", location(node));
  }
  if (root === context.flowName) throw new WorkflowScriptError("The flow API is frozen", location(node));
  const owner = nearestAncestorFunction(context, node);
  if (owner && parameterAliases(owner).has(root)) {
    throw new WorkflowScriptError(`Pure workflow callbacks may not mutate parameter ${root}`, location(node));
  }
}

function parameterAliases(fn: WorkflowAstNode): Set<string> {
  const aliases = functionParameterNames(fn);
  const assignments: Array<{ targets: string[]; source?: string }> = [];
  walk(fn.body, (node) => {
    if (node !== fn.body && isFunction(node)) return false;
    if (node.type === "VariableDeclarator") {
      const targets = new Set<string>();
      collectPatternNames(node.id, targets);
      assignments.push({ targets: [...targets], source: rootIdentifier(node.init) });
    }
    if (node.type === "AssignmentExpression" && node.operator === "=") {
      const targets = new Set<string>();
      collectPatternNames(node.left, targets);
      assignments.push({ targets: [...targets], source: rootIdentifier(node.right) });
    }
    return undefined;
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
  return aliases;
}

export function validateDuplicateSiblingIds(context: WorkflowSourceContext): void {
  const byOwner = new Map<WorkflowAstNode, Array<{ node: WorkflowAstNode; id: string }>>();
  for (const operation of context.operationCalls) {
    const owner = semanticOwner(context, operation.node);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), { node: operation.node, id: operation.id }]);
  }
  for (const calls of byOwner.values()) {
    for (let left = 0; left < calls.length; left++) {
      for (let right = left + 1; right < calls.length; right++) {
        if (calls[left]!.id !== calls[right]!.id || areStaticallyExclusive(context, calls[left]!.node, calls[right]!.node)) continue;
        throw new WorkflowScriptError(`Duplicate sibling operation id ${calls[left]!.id}`, location(calls[right]!.node));
      }
    }
  }
}

export function validateRecursion(context: WorkflowSourceContext): void {
  const functions = new Map<string, WorkflowAstNode>();
  walk(context.ast, (node, parent) => {
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id?.name) functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFunction(node.init)) functions.set(node.id.name, node.init);
    if (isFunction(node) && parent && parent !== context.ast && node !== context.runNode && node.id?.name) functions.set(node.id.name, node);
  });
  const graph = new Map<string, Set<string>>();
  for (const [name, fn] of functions) {
    const edges = new Set<string>();
    walk(fn.body, (node) => {
      if (node !== fn.body && isFunction(node)) return false;
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" && functions.has(node.callee.name)) edges.add(node.callee.name);
      return undefined;
    });
    graph.set(name, edges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new WorkflowScriptError(`Recursive workflow helper ${name} is forbidden`, location(functions.get(name)));
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of graph.get(name) ?? []) visit(child);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of functions.keys()) visit(name);
}

function writesBinding(node: WorkflowAstNode, name: string): boolean {
  let written = false;
  walk(node, (candidate) => {
    if (written) return false;
    if (
      (candidate.type === "AssignmentExpression" && patternContainsName(candidate.left, name)) ||
      (candidate.type === "UpdateExpression" && patternContainsName(candidate.argument, name)) ||
      (["ForInStatement", "ForOfStatement"].includes(candidate.type) && patternContainsName(candidate.left, name))
    ) written = true;
    return undefined;
  });
  return written;
}

function patternContainsName(node: WorkflowAstNode | undefined, name: string): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "MemberExpression") return false;
  if (node.type === "RestElement") return patternContainsName(node.argument, name);
  if (node.type === "AssignmentPattern") return patternContainsName(node.left, name);
  if (node.type === "ArrayPattern") return node.elements.some((entry: WorkflowAstNode) => patternContainsName(entry, name));
  if (node.type === "ObjectPattern") return node.properties.some((property: WorkflowAstNode) => patternContainsName(property.value ?? property.argument, name));
  if (node.type === "VariableDeclaration") return node.declarations.some((declaration: WorkflowAstNode) => patternContainsName(declaration.id, name));
  return false;
}

function semanticOwner(context: WorkflowSourceContext, node: WorkflowAstNode): WorkflowAstNode {
  let current = node;
  while (true) {
    const entry = context.parents.get(current);
    if (!entry) return context.runNode;
    current = entry.parent;
    if (isFunction(current) && context.callbacks.has(current)) {
      const kind = context.callbacks.get(current);
      if (kind !== "loop-condition" && kind !== "fanout-key") return current;
    }
  }
}

function areStaticallyExclusive(context: WorkflowSourceContext, left: WorkflowAstNode, right: WorkflowAstNode): boolean {
  const leftBranches = controlBranches(context, left);
  const rightBranches = controlBranches(context, right);
  for (const [control, branch] of leftBranches) {
    const other = rightBranches.get(control);
    if (other !== undefined && other !== branch) return true;
  }
  return false;
}

function controlBranches(context: WorkflowSourceContext, node: WorkflowAstNode): Map<number, string> {
  const result = new Map<number, string>();
  let child = node;
  while (true) {
    const entry = context.parents.get(child);
    if (!entry) break;
    const parent = entry.parent;
    if (parent.type === "IfStatement" && (entry.key === "consequent" || entry.key === "alternate")) result.set(parent.start, entry.key);
    if (parent.type === "ConditionalExpression" && (entry.key === "consequent" || entry.key === "alternate")) result.set(parent.start, entry.key);
    if (parent.type === "SwitchCase") {
      const switchEntry = context.parents.get(parent);
      if (switchEntry?.parent.type === "SwitchStatement") result.set(switchEntry.parent.start, String(parent.start));
    }
    if (isFunction(parent)) break;
    child = parent;
  }
  return result;
}

function containsFlowCall(node: WorkflowAstNode, flowName: string): boolean {
  let found = false;
  walk(node, (child) => {
    if (getFlowCall(child, flowName)) { found = true; return false; }
    return found ? false : undefined;
  });
  return found;
}

function nearestAncestorFunction(context: WorkflowSourceContext, node: WorkflowAstNode): WorkflowAstNode | undefined {
  let current = node;
  while (true) {
    const entry = context.parents.get(current);
    if (!entry) return undefined;
    current = entry.parent;
    if (isFunction(current)) return current;
  }
}

function functionAncestors(context: WorkflowSourceContext, node: WorkflowAstNode): WorkflowAstNode[] {
  const result: WorkflowAstNode[] = [];
  let current = node;
  while (true) {
    const entry = context.parents.get(current);
    if (!entry) return result;
    current = entry.parent;
    if (isFunction(current)) result.push(current);
  }
}

function insideCallback(context: WorkflowSourceContext, node: WorkflowAstNode, kind: string): boolean {
  return functionAncestors(context, node).some((ancestor) => context.callbacks.get(ancestor) === kind);
}

function isAwaitedOrReturnedOperation(context: WorkflowSourceContext, node: WorkflowAstNode): boolean {
  const entry = context.parents.get(node);
  if (!entry) return false;
  if (entry.parent.type === "AwaitExpression" && entry.key === "argument") return true;
  if (entry.parent.type === "ReturnStatement" && entry.key === "argument") return true;
  return entry.parent.type === "ArrowFunctionExpression" && entry.key === "body";
}

function collectDeclaredNames(fn: WorkflowAstNode): Set<string> {
  const result = new Set<string>();
  for (const parameter of fn.params ?? []) collectPatternNames(parameter, result);
  walk(fn.body, (node) => {
    if (node.type === "VariableDeclarator") collectPatternNames(node.id, result);
    if (node.type === "FunctionDeclaration" && node.id) result.add(node.id.name);
    if (node.type === "CatchClause" && node.param) collectPatternNames(node.param, result);
  });
  return result;
}

function collectPatternNames(pattern: WorkflowAstNode, result: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") result.add(pattern.name);
  else if (pattern.type === "RestElement") collectPatternNames(pattern.argument, result);
  else if (pattern.type === "AssignmentPattern") collectPatternNames(pattern.left, result);
  else if (pattern.type === "ArrayPattern") for (const entry of pattern.elements) collectPatternNames(entry, result);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) collectPatternNames(property.value ?? property.argument, result);
}

function functionParameterNames(fn: WorkflowAstNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params ?? []) collectPatternNames(parameter, names);
  return names;
}

function isMutationNode(node: WorkflowAstNode): boolean {
  if (["AssignmentExpression", "UpdateExpression"].includes(node?.type)) return true;
  if (node?.type === "UnaryExpression" && node.operator === "delete") return true;
  return node?.type === "CallExpression" && node.callee?.type === "MemberExpression" && MUTATING_METHODS.has(memberPropertyName(node.callee) ?? "");
}

function mutationTarget(node: WorkflowAstNode): WorkflowAstNode | undefined {
  if (node.type === "AssignmentExpression") return node.left;
  if (node.type === "UpdateExpression" || node.type === "UnaryExpression") return node.argument;
  if (node.type === "CallExpression") return node.callee.object;
  return undefined;
}

function mutatesReferencedValue(node: WorkflowAstNode): boolean {
  if (node.type === "CallExpression") return true;
  const target = mutationTarget(node);
  return target?.type === "MemberExpression" || target?.type === "ChainExpression";
}

function rootIdentifier(node: WorkflowAstNode | undefined): string | undefined {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "ChainExpression") {
    current = current.type === "ChainExpression" ? current.expression : current.object;
  }
  return current?.type === "Identifier" ? current.name : undefined;
}

function isMember(node: WorkflowAstNode, object: string, property: string): boolean {
  return node?.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === object && memberPropertyName(node) === property;
}

function isNonComputedPropertyKey(_node: WorkflowAstNode, parent: WorkflowAstNode | undefined, key: string | undefined): boolean {
  return Boolean(parent && ((parent.type === "Property" && key === "key" && !parent.computed) ||
    (parent.type === "MemberExpression" && key === "property" && !parent.computed)));
}

function isDeclarationIdentifier(_node: WorkflowAstNode, parent: WorkflowAstNode | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "VariableDeclarator" && key === "id") return true;
  if (["FunctionDeclaration", "FunctionExpression"].includes(parent.type) && (key === "id" || key === "params")) return true;
  if (parent.type === "ArrowFunctionExpression" && key === "params") return true;
  return parent.type === "CatchClause" && key === "param";
}

function isDefinitionCallee(
  context: WorkflowSourceContext,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): boolean {
  return parent?.type === "CallExpression" && key === "callee" && parent.arguments?.[0] === context.definitionNode;
}

function isTopLevelBinding(context: WorkflowSourceContext, node: WorkflowAstNode): boolean {
  let current = node;
  while (true) {
    const entry = context.parents.get(current);
    if (!entry) return true;
    current = entry.parent;
    if (isFunction(current)) return false;
    if (current.type === "Program") return true;
  }
}

function isLexicallyBound(context: WorkflowSourceContext, node: WorkflowAstNode, name: string): boolean {
  let current = node;
  while (true) {
    const entry = context.parents.get(current);
    if (!entry) return context.constants.has(name);
    current = entry.parent;
    if (isFunction(current) && collectDeclaredNames(current).has(name)) return true;
    if (current.type === "Program") return context.constants.has(name);
  }
}
