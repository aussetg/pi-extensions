// Executable oracle for the workflow runtime conformance contract.
import crypto from "node:crypto";

export const effect = (name, semantic, result = semantic, options = {}) => ({
  kind: "effect",
  name,
  semantic,
  result,
  replayable: options.replayable !== false,
  failure: options.failure ?? null,
});

export const parallel = (name, lanes, options = {}) => ({
  kind: "parallel",
  name,
  lanes,
  order: options.order ?? Object.keys(lanes),
  errors: options.errors ?? "fail-fast",
});

export const mapped = (name, lanes, order = Object.keys(lanes), options = {}) => ({
  kind: "map",
  name,
  lanes,
  order,
  errors: options.errors ?? "fail-fast",
});

export const candidate = (name, body, output = null) => ({
  kind: "candidate",
  name,
  body,
  output,
});

export const sequence = (...commands) => commands.flat();

/**
 * Build the semantic tree independently from scheduler completion order.
 * Sequential slots are identity. Names are display/source metadata only.
 */
export function buildTree(program, options = {}) {
  return buildScope(program, "run", rootSeed(), options.runId ?? "run-a");
}

function buildScope(commands, path, seed, runId) {
  const nodes = [];
  let previous = seed;
  for (let slot = 0; slot < commands.length; slot++) {
    const command = commands[slot];
    const nodePath = `${path}/${pad(slot)}`;
    if (command.kind === "effect") {
      const callKey = hash({
        format: 1,
        previous,
        path: nodePath,
        kind: "effect",
        semantic: command.semantic,
        replayable: command.replayable,
        execution: runId,
        terminal: command.failure ? { failure: command.failure } : { result: command.result },
      });
      const node = {
        kind: "effect",
        path: nodePath,
        display: command.name,
        semantic: command.semantic,
        result: command.result,
        replayable: command.replayable,
        failure: command.failure,
        previous,
        terminalKey: callKey,
      };
      nodes.push(node);
      previous = callKey;
      continue;
    }

    if (command.kind === "parallel" || command.kind === "map") {
      const laneEntries = Object.entries(command.lanes).map(([key, lane]) => {
        const laneSeed = hash({
          format: 1,
          parentPrevious: previous,
          parentPath: nodePath,
          groupKind: command.kind,
          lane: key,
        });
        return [key, buildScope(
          lane,
          `${nodePath}/${command.kind === "map" ? "item" : "branch"}:${key}`,
          laneSeed,
          runId,
        )];
      });
      const lanes = Object.fromEntries(laneEntries);
      const joinKey = hash({
        format: 1,
        previous,
        path: nodePath,
        kind: command.kind,
        errors: command.errors,
        order: command.order,
        lanes: command.order.map((key) => ({ key, terminalKey: lanes[key]?.terminalKey ?? null })),
      });
      nodes.push({
        kind: command.kind,
        path: nodePath,
        display: command.name,
        errors: command.errors,
        order: [...command.order],
        previous,
        lanes,
        terminalKey: joinKey,
      });
      previous = joinKey;
      continue;
    }

    if (command.kind === "candidate") {
      const bodySeed = hash({
        format: 1,
        parentPrevious: previous,
        parentPath: nodePath,
        groupKind: "candidate",
      });
      const body = buildScope(command.body, `${nodePath}/candidate`, bodySeed, runId);
      const joinKey = hash({
        format: 1,
        previous,
        path: nodePath,
        kind: "candidate",
        body: body.terminalKey,
        output: command.output,
      });
      nodes.push({
        kind: "candidate",
        path: nodePath,
        display: command.name,
        previous,
        body,
        output: command.output,
        terminalKey: joinKey,
      });
      previous = joinKey;
      continue;
    }

    throw new TypeError(`Unknown command kind ${String(command?.kind)}`);
  }
  return { kind: "scope", path, seed, runId, nodes, terminalKey: previous };
}

/**
 * Causal replay: each sequential scope is prefix-only, while sibling lanes are
 * independent. A structural join authenticates lane provenance and order.
 */
export function replayTree(source, target) {
  const reused = [];
  const misses = [];
  const terminalKey = replayScope(source, target, reused, misses, true, target.seed);
  return { reused, misses, terminalKey };
}

function replayScope(source, target, reused, misses, eligible, effectiveSeed) {
  let prefix = eligible && source.seed === effectiveSeed;
  let previous = effectiveSeed;
  for (let slot = 0; slot < target.nodes.length; slot++) {
    const oldNode = source.nodes[slot];
    const newNode = target.nodes[slot];
    if (
      !prefix || !oldNode || oldNode.previous !== previous
      || oldNode.kind !== newNode.kind || oldNode.path !== newNode.path
    ) {
      if (prefix) misses.push({ path: newNode.path, reason: oldNode ? "kind changed" : "source prefix ended" });
      prefix = false;
    }

    if (newNode.kind === "effect") {
      if (
        prefix && oldNode.replayable && newNode.replayable && !oldNode.failure
        && oldNode.semantic === newNode.semantic
      ) {
        reused.push(newNode.path);
        // A replayed call retains the source call key and result. A
        // hypothetical fresh result in the target program is irrelevant.
        previous = oldNode.terminalKey;
      } else {
        if (prefix) {
          misses.push({
            path: newNode.path,
            reason: !oldNode.replayable || !newNode.replayable
              ? "non-replayable"
              : oldNode.failure
                ? "failed effect"
                : "semantic key changed",
          });
        }
        prefix = false;
        previous = liveEffectKey(newNode, previous, target.runId);
      }
      continue;
    }

    if (newNode.kind === "parallel" || newNode.kind === "map") {
      // Lanes are causally independent once the parent prefix reaches this
      // group. Added/removed/reordered lanes change the join, not unchanged
      // lane prefixes.
      const effectiveLanes = {};
      for (const [key, targetLane] of Object.entries(newNode.lanes)) {
        const sourceLane = prefix ? oldNode.lanes[key] : undefined;
        const laneSeed = hash({
          format: 1,
          parentPrevious: previous,
          parentPath: newNode.path,
          groupKind: newNode.kind,
          lane: key,
        });
        effectiveLanes[key] = replayScope(
          sourceLane ?? emptySourceScope(targetLane.path, laneSeed),
          targetLane,
          reused,
          misses,
          Boolean(sourceLane),
          laneSeed,
        );
      }
      const joinKey = hash({
        format: 1,
        previous,
        path: newNode.path,
        kind: newNode.kind,
        errors: newNode.errors,
        order: newNode.order,
        lanes: newNode.order.map((key) => ({ key, terminalKey: effectiveLanes[key] ?? null })),
      });
      if (!prefix || oldNode.terminalKey !== joinKey) {
        misses.push({ path: newNode.path, reason: "structural join changed" });
        prefix = false;
      }
      previous = joinKey;
      continue;
    }

    if (newNode.kind === "candidate") {
      const bodySeed = hash({
        format: 1,
        parentPrevious: previous,
        parentPath: newNode.path,
        groupKind: "candidate",
      });
      const bodyKey = replayScope(
        prefix ? oldNode.body : emptySourceScope(newNode.body.path, bodySeed),
        newNode.body,
        reused,
        misses,
        prefix,
        bodySeed,
      );
      const joinKey = hash({
        format: 1,
        previous,
        path: newNode.path,
        kind: "candidate",
        body: bodyKey,
        output: newNode.output,
      });
      if (!prefix || oldNode.terminalKey !== joinKey) {
        misses.push({ path: newNode.path, reason: "candidate join changed" });
        prefix = false;
      }
      previous = joinKey;
      continue;
    }
  }
  return previous;
}

function liveEffectKey(node, previous, runId) {
  return hash({
    format: 1,
    previous,
    path: node.path,
    kind: "effect",
    semantic: node.semantic,
    replayable: node.replayable,
    execution: runId,
    terminal: node.failure ? { failure: node.failure } : { result: node.result },
  });
}

function emptySourceScope(path, seed) {
  return { kind: "scope", path, seed, runId: "<none>", nodes: [], terminalKey: seed };
}

/**
 * Model the current global-prefix property. Completion order is source-run
 * evidence, so unrelated-lane reuse can depend on scheduler timing.
 */
export function replayGlobalPrefix(sourceCalls, targetTree) {
  const target = new Map(flattenEffects(targetTree).map((node) => [node.path, node]));
  const reused = [];
  let miss = null;
  for (const source of sourceCalls) {
    const current = target.get(source.path);
    if (
      !current || !source.replayable || !current.replayable || source.failure || current.failure
      || source.semantic !== current.semantic
    ) {
      miss = source.path;
      break;
    }
    reused.push(source.path);
  }
  return { reused, miss };
}

export function flattenEffects(tree) {
  const result = [];
  const visit = (scope) => {
    for (const node of scope.nodes) {
      if (node.kind === "effect") result.push(node);
      else if (node.kind === "candidate") visit(node.body);
      else for (const lane of Object.values(node.lanes)) visit(lane);
    }
  };
  visit(tree);
  return result;
}

export function callsInOrder(tree, paths) {
  const effects = new Map(flattenEffects(tree).map((node) => [node.path, node]));
  return paths.map((path) => {
    const node = effects.get(path);
    if (!node) throw new Error(`Unknown effect path ${path}`);
    return node;
  });
}

export function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function rootSeed() {
  return hash({ format: 1, root: "workflow" });
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function pad(value) {
  return String(value).padStart(6, "0");
}
