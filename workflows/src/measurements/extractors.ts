import { Ajv } from "ajv";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { JsonObject } from "../types.js";
import type {
  DiagnosticMeasurementExtractor,
  MeasurementProfileSnapshot,
  NumericMeasurementExtractor,
  RegexMeasurementExtractor,
} from "./profiles.js";

export interface ExtractedMeasurementInvocation {
  values: Record<string, number>;
  diagnostic?: JsonObject;
}

export class MeasurementOutputError extends Error {
  readonly failureKind = "output" as const;

  constructor(message: string) {
    super(message);
    this.name = "MeasurementOutputError";
  }
}

export function extractMeasurementInvocation(
  profile: MeasurementProfileSnapshot,
  selectedOutputIds: readonly string[],
  stdout: Buffer,
): ExtractedMeasurementInvocation {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new MeasurementOutputError("Measurement stdout is not valid UTF-8");
  }
  const selected = [...selectedOutputIds].sort();
  if (selected.length === 0) throw new MeasurementOutputError("Measurement output selection is empty");
  for (const outputId of selected) {
    if (!profile.outputs[outputId]) throw new MeasurementOutputError(`Measurement profile has no output ${outputId}`);
  }

  const protocol = Object.values(profile.outputs).some((output) => output.extract.kind === "protocol");
  if (protocol) return extractProtocol(profile, selected, text);

  let json: unknown;
  const needsJson = selected.some((outputId) => profile.outputs[outputId]!.extract.kind === "json-path") ||
    profile.diagnostics?.extract.kind === "json-path";
  if (needsJson) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new MeasurementOutputError(`Measurement stdout is not JSON: ${message(error)}`);
    }
  }
  const values: Record<string, number> = {};
  for (const outputId of selected) {
    const extractor = profile.outputs[outputId]!.extract;
    values[outputId] = extractNumeric(extractor, text, json, outputId);
  }
  const diagnostic = profile.diagnostics
    ? validateDiagnostic(extractDiagnostic(profile.diagnostics.extract, json), profile)
    : undefined;
  return deepFreezeJson(canonicalJsonObject({
    values,
    ...(diagnostic ? { diagnostic } : {}),
  }, invocationLimits())) as unknown as ExtractedMeasurementInvocation;
}

function extractProtocol(
  profile: MeasurementProfileSnapshot,
  selected: readonly string[],
  text: string,
): ExtractedMeasurementInvocation {
  const declared = new Set(Object.keys(profile.outputs));
  const values = new Map<string, number>();
  let diagnostic: JsonObject | undefined;
  const maximumRecords = declared.size + (profile.diagnostics ? 1 : 0);
  let recordCount = text.length === 0 ? 0 : 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 0x0a && index < text.length - 1) recordCount++;
    if (recordCount > maximumRecords) throw new MeasurementOutputError("Measurement protocol contains too many records");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 1 && lines[0] === "") throw new MeasurementOutputError("Measurement protocol output is empty");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") throw new MeasurementOutputError(`Measurement protocol contains an empty record at line ${index + 1}`);
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new MeasurementOutputError(`Malformed measurement protocol record at line ${index + 1}: ${message(error)}`);
    }
    if (!isRecord(raw)) throw new MeasurementOutputError(`Measurement protocol record ${index + 1} must be an object`);
    if (raw.type === "metric") {
      assertKeys(raw, new Set(["type", "id", "value"]), `metric record ${index + 1}`);
      if (typeof raw.id !== "string" || !declared.has(raw.id)) {
        throw new MeasurementOutputError(`Unexpected measurement output ${String(raw.id)} at line ${index + 1}`);
      }
      if (values.has(raw.id)) throw new MeasurementOutputError(`Duplicate measurement output ${raw.id}`);
      values.set(raw.id, finiteNumber(raw.value, `measurement output ${raw.id}`));
      continue;
    }
    if (raw.type === "diagnostic") {
      assertKeys(raw, new Set(["type", "data"]), `diagnostic record ${index + 1}`);
      if (!profile.diagnostics) throw new MeasurementOutputError("Unexpected measurement diagnostic output");
      if (diagnostic !== undefined) throw new MeasurementOutputError("Duplicate measurement diagnostic output");
      diagnostic = validateDiagnostic(raw.data, profile);
      continue;
    }
    throw new MeasurementOutputError(`Unknown measurement protocol record type ${String(raw.type)}`);
  }
  for (const outputId of selected) {
    if (!values.has(outputId)) throw new MeasurementOutputError(`Missing measurement output ${outputId}`);
  }
  if (profile.diagnostics && diagnostic === undefined) throw new MeasurementOutputError("Missing measurement diagnostic output");
  const selectedValues: Record<string, number> = {};
  for (const outputId of selected) selectedValues[outputId] = values.get(outputId)!;
  return deepFreezeJson(canonicalJsonObject({
    values: selectedValues,
    ...(diagnostic ? { diagnostic } : {}),
  }, invocationLimits())) as unknown as ExtractedMeasurementInvocation;
}

function extractNumeric(
  extractor: NumericMeasurementExtractor,
  text: string,
  parsedJson: unknown,
  outputId: string,
): number {
  if (extractor.kind === "protocol") throw new MeasurementOutputError("Mixed measurement protocol extraction is invalid");
  if (extractor.kind === "json-path") {
    return finiteNumber(readJsonPath(parsedJson, extractor.path), `measurement output ${outputId}`);
  }
  return extractRegex(extractor, text, outputId);
}

function extractRegex(extractor: RegexMeasurementExtractor, text: string, outputId: string): number {
  const expression = new RegExp(extractor.pattern, `${extractor.flags ?? ""}gu`);
  let match: RegExpExecArray | undefined;
  for (const candidate of text.matchAll(expression)) {
    if (match) throw new MeasurementOutputError(`Duplicate measurement output ${outputId}`);
    match = candidate;
  }
  if (!match) throw new MeasurementOutputError(`Missing measurement output ${outputId}`);
  const group = extractor.group ?? (match.length > 1 ? 1 : 0);
  const raw = typeof group === "number" ? match[group] : match.groups?.[group];
  if (raw === undefined) throw new MeasurementOutputError(`Regex group for measurement output ${outputId} did not match`);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
    throw new MeasurementOutputError(`Measurement output ${outputId} is not a numeric token`);
  }
  return finiteNumber(Number(raw), `measurement output ${outputId}`);
}

function extractDiagnostic(extractor: DiagnosticMeasurementExtractor, parsedJson: unknown): unknown {
  if (extractor.kind === "protocol") throw new MeasurementOutputError("Mixed measurement protocol extraction is invalid");
  return readJsonPath(parsedJson, extractor.path);
}

function validateDiagnostic(value: unknown, profile: MeasurementProfileSnapshot): JsonObject {
  if (!profile.diagnostics) throw new MeasurementOutputError("Measurement profile does not declare diagnostics");
  let diagnostic: JsonObject;
  try {
    diagnostic = canonicalJsonObject(value, diagnosticLimits());
  } catch (error) {
    throw new MeasurementOutputError(`Measurement diagnostic is not bounded JSON: ${message(error)}`);
  }
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(profile.diagnostics.schema);
  if (!validate(diagnostic)) {
    throw new MeasurementOutputError(`Measurement diagnostic failed schema: ${ajv.errorsText(validate.errors)}`);
  }
  return deepFreezeJson(diagnostic);
}

function readJsonPath(value: unknown, jsonPath: string): unknown {
  if (jsonPath === "$") return value;
  let current = value;
  const tokens = jsonPath.slice(1).match(/\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]*)\]/g) ?? [];
  if (`$${tokens.join("")}` !== jsonPath) throw new MeasurementOutputError(`Unsupported JSON path ${jsonPath}`);
  for (const token of tokens) {
    if (token.startsWith(".")) {
      const key = token.slice(1);
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
        throw new MeasurementOutputError(`JSON path ${jsonPath} is missing ${key}`);
      }
      current = current[key];
    } else {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(current) || index >= current.length) throw new MeasurementOutputError(`JSON path ${jsonPath} is missing index ${index}`);
      current = current[index];
    }
  }
  return current;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MeasurementOutputError(`${label} must be a finite number`);
  return Object.is(value, -0) ? 0 : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertKeys(value: Record<string, unknown>, expected: Set<string>, label: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new MeasurementOutputError(`${label} contains missing or extra fields`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invocationLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.measurementDiagnosticBytes + DEFINITION_LIMITS.measurementOutputs * 64,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}

function diagnosticLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.measurementDiagnosticBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}
