export function normalizeMetricState(value) {
  const state = requireRecord(value, "workflow metric state");
  assertExactKeys(state, [
    "metricId", "definition", "baseline", "current", "best", "relativeGain", "observationCount",
  ], "workflow metric state");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(state.metricId)) throw new Error("Workflow metric id is invalid");
  requireRecord(state.definition, "workflow metric definition");
  for (const key of ["baseline", "current", "best", "relativeGain"]) {
    if (state[key] !== null && (typeof state[key] !== "number" || !Number.isFinite(state[key]) || Object.is(state[key], -0))) {
      throw new Error(`Workflow metric ${key} is invalid`);
    }
  }
  if (!Number.isSafeInteger(state.observationCount) || state.observationCount < 0) {
    throw new Error("Workflow metric observation count is invalid");
  }
  return deepFreeze(state);
}

export function metricSummary(state) {
  return Object.freeze({
    baseline: state.baseline,
    current: state.current,
    best: state.best,
    relativeGain: state.relativeGain,
    observationCount: state.observationCount,
  });
}

export function reachesTarget(state) {
  requireBaseline(state);
  const target = state.definition.target;
  if (!target) return condition(false, `${state.definition.title} has no target`, { metricId: state.metricId, best: state.best });
  const best = state.best;
  let reached;
  let effectiveValue;
  if (target.kind === "value") {
    effectiveValue = target.value;
    reached = state.definition.direction === "maximize" ? best >= target.value : best <= target.value;
  } else if (target.kind === "absoluteGain") {
    effectiveValue = finite(state.definition.direction === "maximize" ? state.baseline + target.value : state.baseline - target.value);
    reached = goodChange(state.definition.direction, best, state.baseline) >= target.value;
  } else {
    const gain = relativeGoodChange(state.definition.direction, best, state.baseline, "relative target");
    effectiveValue = finite(state.definition.direction === "maximize"
      ? state.baseline + Math.abs(state.baseline) * target.value
      : state.baseline - Math.abs(state.baseline) * target.value);
    reached = gain >= target.value;
  }
  return condition(reached, reached ? `${state.definition.title} target reached` : `${state.definition.title} target not reached`, {
    metricId: state.metricId,
    baseline: state.baseline,
    best,
    targetKind: target.kind,
    target: target.value,
    effectiveValue,
  });
}

export function needsImprovement(state) {
  const target = reachesTarget(state);
  return Object.freeze({
    result: !target.result,
    label: target.result ? "metric target reached" : "metric still needs improvement",
    ...(target.operands ? { operands: target.operands } : {}),
  });
}

export function isImprovement(state, observation) {
  const normalized = normalizeObservation(observation);
  assertObservationMetric(state, normalized);
  requireBaseline(state);
  const reference = state.best;
  const threshold = state.definition.improvement;
  if (threshold?.minimumRelative !== undefined && reference === 0) {
    throw new Error(`Metric ${state.metricId} cannot use relative minimum improvement with a zero reference`);
  }
  const change = goodChange(state.definition.direction, normalized.value, reference);
  if (!(change > 0)) return false;
  if (!threshold) return true;
  if (threshold.minimumAbsolute !== undefined && change < threshold.minimumAbsolute) return false;
  return threshold.minimumRelative === undefined ||
    relativeGoodChange(state.definition.direction, normalized.value, reference, "relative minimum improvement") >= threshold.minimumRelative;
}

export function isWithinGuardrail(state, observation) {
  const normalized = normalizeObservation(observation);
  assertObservationMetric(state, normalized);
  requireBaseline(state);
  const guardrail = state.definition.guardrail;
  if (!guardrail) return true;
  const reference = guardrail.reference === "baseline" ? state.baseline : state.best ?? state.baseline;
  if (guardrail.maximumRelativeRegression !== undefined && reference === 0) {
    throw new Error(`Metric ${state.metricId} cannot use a relative guardrail with a zero reference`);
  }
  const regression = -goodChange(state.definition.direction, normalized.value, reference);
  if (guardrail.maximumAbsoluteRegression !== undefined && regression > guardrail.maximumAbsoluteRegression) return false;
  return guardrail.maximumRelativeRegression === undefined || regression / Math.abs(reference) <= guardrail.maximumRelativeRegression;
}

function normalizeObservation(value) {
  if (
    !value || typeof value !== "object" ||
    !/^observation_[a-f0-9]{32}$/.test(value.observationId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.metricId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.outputId) ||
    typeof value.value !== "number" || !Number.isFinite(value.value) ||
    !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 64 ||
    value.samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample))
  ) throw new Error("Metric observation is invalid");
  return deepFreeze(structuredClone(value));
}

function assertObservationMetric(state, observation) {
  if (observation.metricId !== state.metricId) {
    throw new Error(`Observation ${observation.observationId} belongs to metric ${observation.metricId}, not ${state.metricId}`);
  }
}

function requireBaseline(state) {
  if (state.baseline === null || state.best === null) throw new Error(`Metric ${state.metricId} has no baseline observation`);
}

function goodChange(direction, value, reference) {
  return direction === "maximize" ? value - reference : reference - value;
}

function relativeGoodChange(direction, value, reference, label) {
  if (reference === 0) throw new Error(`Cannot compute ${label} from a zero metric reference`);
  return goodChange(direction, value, reference) / Math.abs(reference);
}

function finite(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Metric calculation is not finite");
  return Object.is(value, -0) ? 0 : value;
}

function condition(result, label, operands) {
  return Object.freeze({ result, label, operands: deepFreeze(operands) });
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
