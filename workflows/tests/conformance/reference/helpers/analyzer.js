// Executable oracle for the workflow runtime conformance contract.
import { parse } from "acorn";

const CONCURRENT_FORBIDDEN = new Set(["ask", "apply"]);

export function analyzeHelpers(source) {
  const ast = parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const parents = new Map();
  walk(ast, (node, parent, key) => { if (parent) parents.set(node, { parent, key }); });

  const bindings = new Map();
  const functions = new Set();
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) {
      bindings.set(node.id.name, node);
      functions.add(node);
    }
    if (
      node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && isFunction(node.init)
    ) {
      bindings.set(node.id.name, node.init);
      functions.add(node.init);
    }
    if (isFunction(node)) functions.add(node);
  });

  const run = bindings.get("run");
  if (!run) throw new Error("one async function run(flow, args) is required for this probe");

  const directEffects = new Map([...functions].map((fn) => [fn, []]));
  const graph = new Map([...functions].map((fn) => [fn, new Set()]));
  const callbackContexts = new Map();

  for (const fn of functions) {
    walkOwn(fn.body, (node) => {
      const method = flowMethod(node);
      if (method) {
        directEffects.get(fn).push({ method, node });
        markCallbacks(node, method, bindings, callbackContexts);
      }
      if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
        const target = bindings.get(node.callee.name);
        if (target) graph.get(fn).add(target);
      }
    });
  }

  rejectRecursion(functions, graph, bindingName(bindings));

  const effectful = new Set([...functions].filter((fn) => directEffects.get(fn).length > 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (effectful.has(fn)) continue;
      if ([...graph.get(fn)].some((child) => effectful.has(child))) {
        effectful.add(fn);
        changed = true;
      }
    }
  }

  const contexts = new Map([...functions].map((fn) => [fn, new Set()]));
  contexts.get(run).add("root");
  for (const [fn, values] of callbackContexts) for (const value of values) contexts.get(fn).add(value);
  changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      for (const child of graph.get(fn)) {
        for (const context of contexts.get(fn)) {
          if (!contexts.get(child).has(context)) {
            contexts.get(child).add(context);
            changed = true;
          }
        }
      }
    }
  }

  for (const fn of effectful) {
    for (const effect of directEffects.get(fn)) {
      if (
        contexts.get(fn).has("concurrent")
        && CONCURRENT_FORBIDDEN.has(effect.method)
      ) throw new Error(`flow.${effect.method} is unavailable in concurrent helper ${nameOf(fn, bindings)}`);
    }
  }

  walk(ast, (node, parent, key) => {
    if (node.type !== "Identifier") return;
    const fn = bindings.get(node.name);
    if (!fn || !effectful.has(fn) || isDeclaration(node, parent, key)) return;
    if (parent?.type === "CallExpression" && key === "callee") return;
    if (isExactStructuredCallback(parent, node, parents)) return;
    throw new Error(`effectful helper ${node.name} may not escape or use dynamic dispatch`);
  });

  for (const fn of effectful) {
    if (contexts.get(fn).size === 0) {
      throw new Error(`effectful helper ${nameOf(fn, bindings)} is unreachable from run`);
    }
  }

  return {
    functions: [...functions].map((fn) => ({
      name: nameOf(fn, bindings),
      effectful: effectful.has(fn),
      contexts: [...contexts.get(fn)].sort(),
      effects: directEffects.get(fn).map((effect) => effect.method),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function markCallbacks(call, method, bindings, result) {
  const mark = (node, context) => {
    const fn = resolveFunction(node, bindings);
    if (!fn) throw new Error(`flow.${method} requires a lexically known callback`);
    const values = result.get(fn) ?? new Set();
    values.add(context);
    result.set(fn, values);
  };
  if (method === "map") mark(call.arguments[1], "concurrent");
  else if (method === "candidate") mark(call.arguments[0], "candidate");
  else if (method === "parallel") {
    const branches = call.arguments[0];
    if (branches?.type !== "ObjectExpression") throw new Error("flow.parallel branches must be a literal object");
    for (const property of branches.properties) mark(property.value, "concurrent");
  }
}

function rejectRecursion(functions, graph, names) {
  const active = new Set();
  const done = new Set();
  const visit = (fn) => {
    if (active.has(fn)) throw new Error(`recursive helper ${names.get(fn) ?? "<anonymous>"} is unavailable`);
    if (done.has(fn)) return;
    active.add(fn);
    for (const child of graph.get(fn)) visit(child);
    active.delete(fn);
    done.add(fn);
  };
  for (const fn of functions) visit(fn);
}

function bindingName(bindings) {
  return new Map([...bindings].map(([name, fn]) => [fn, name]));
}

function nameOf(fn, bindings) {
  for (const [name, value] of bindings) if (value === fn) return name;
  return `<callback@${fn.start}>`;
}

function resolveFunction(node, bindings) {
  if (isFunction(node)) return node;
  if (node?.type === "Identifier") return bindings.get(node.name);
  return undefined;
}

function flowMethod(node) {
  if (
    node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression"
    || node.callee.computed || node.callee.object?.type !== "Identifier"
    || node.callee.object.name !== "flow" || node.callee.property?.type !== "Identifier"
  ) return undefined;
  return node.callee.property.name;
}

function isExactStructuredCallback(parent, node, parents) {
  if (parent?.type === "CallExpression") {
    const method = flowMethod(parent);
    if (method === "map") return parent.arguments[1] === node;
    if (method === "candidate") return parent.arguments[0] === node;
  }
  if (parent?.type !== "Property" || parent.value !== node) return false;
  const object = parents.get(parent)?.parent;
  const call = object ? parents.get(object)?.parent : undefined;
  return object?.type === "ObjectExpression"
    && call?.type === "CallExpression"
    && flowMethod(call) === "parallel"
    && call.arguments[0] === object;
}

function isDeclaration(node, parent, key) {
  return Boolean(
    (parent?.type === "FunctionDeclaration" && key === "id")
    || (parent?.type === "VariableDeclarator" && key === "id")
    || (parent?.type === "Property" && key === "key" && !parent.computed)
  );
}

function isFunction(node) {
  return Boolean(node && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type));
}

function walkOwn(node, visitor) {
  walk(node, (child) => {
    if (child !== node && isFunction(child)) return false;
    return visitor(child);
  });
}

function walk(node, visitor, parent, key) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  if (visitor(node, parent, key) === false) return;
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === "start" || childKey === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor, node, childKey);
    } else walk(value, visitor, node, childKey);
  }
}
