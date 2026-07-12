import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject, WorkflowLayoutNode, WorkflowViewSpec } from "../types.js";
import { UI_LIMITS } from "../constants.js";
import { isJsonPointer } from "../utils/json-pointer.js";
import { byteLength, stripAnsi } from "../utils/truncate.js";
import { toStableJsonValue } from "../utils/stable-json.js";

const FORMATS = new Set(["text", "number", "percent", "duration", "bytes", "tokens", "cost", "status"]);
const SPARKLINE_FORMATS = new Set(["number", "duration", "percent"]);

export class WorkflowViewValidator {
  private readonly stateAjv = new Ajv2020({ allErrors: true, strict: false });

  validateSpec(spec: unknown, existingIds = new Set<string>()): WorkflowViewSpec {
    const json = toStableJsonValue(spec);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("UI spec must be a JSON object");
    if (byteLength(JSON.stringify(json)) > UI_LIMITS.maxSpecBytes) throw new Error(`UI spec exceeds ${UI_LIMITS.maxSpecBytes} bytes`);
    const s = json as unknown as WorkflowViewSpec;
    assertExactKeys(s as any, ["version", "id", "title", "description", "placement", "defaultExpanded", "stateSchema", "initialState", "layout", "expandedLayout", "limits"], "spec");
    if (s.version !== 1) throw new Error("UI spec version must be 1");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(s.id)) throw new Error("UI spec id must match ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$");
    if (existingIds.has(s.id)) throw new Error(`Duplicate UI view id: ${s.id}`);
    if (typeof s.title !== "string" || s.title.trim() === "" || s.title.length > 120) throw new Error("UI spec title is required and must be <= 120 chars");
    if (s.description !== undefined && (typeof s.description !== "string" || s.description.length > 1000)) throw new Error("UI spec description must be <= 1000 chars");
    if (s.placement !== undefined && !["runPanel", "widget", "completion", "artifact"].includes(s.placement)) throw new Error("Invalid UI placement");
    if (s.limits) {
      assertExactKeys(s.limits as any, ["maxRows", "maxSeriesPoints", "updateHz"], "spec.limits");
      normalizePositiveInteger(s.limits as any, "maxRows", UI_LIMITS.maxRowsPerTable, "limits.maxRows");
      normalizePositiveInteger(s.limits as any, "maxSeriesPoints", UI_LIMITS.maxSeriesPoints, "limits.maxSeriesPoints");
      normalizePositiveNumber(s.limits as any, "updateHz", UI_LIMITS.maxUpdateHz, "limits.updateHz");
    }
    let count = 0;
    validateNode(s.layout, 1, () => ++count);
    if (s.expandedLayout) validateNode(s.expandedLayout, 1, () => ++count);
    if (count > UI_LIMITS.maxNodeCount) throw new Error(`UI spec has too many nodes (${count})`);
    if (s.stateSchema) this.stateAjv.compile(s.stateSchema);
    return s;
  }

  validateState(spec: WorkflowViewSpec, state: unknown): JsonObject {
    const json = toStableJsonValue(state);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("UI state must be a JSON object");
    if (byteLength(JSON.stringify(json)) > UI_LIMITS.maxStateBytes) throw new Error(`UI state exceeds ${UI_LIMITS.maxStateBytes} bytes`);
    if (spec.stateSchema) {
      const validate = this.stateAjv.compile(spec.stateSchema);
      if (!validate(json)) throw new Error(`UI state failed schema: ${this.stateAjv.errorsText(validate.errors)}`);
    }
    return json as JsonObject;
  }
}

function normalizePositiveNumber(obj: Record<string, unknown>, key: string, max: number, label: string): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  obj[key] = Math.min(value, max);
}

function normalizePositiveInteger(obj: Record<string, unknown>, key: string, max: number, label: string): void {
  const value = obj[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  obj[key] = Math.min(value as number, max);
}

function assertFiniteNumber(obj: Record<string, unknown>, key: string, label: string): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}.${key} must be a finite number`);
}

function validateNode(node: WorkflowLayoutNode, depth: number, inc: () => number): void {
  if (depth > UI_LIMITS.maxNodeDepth) throw new Error(`UI layout exceeds depth ${UI_LIMITS.maxNodeDepth}`);
  inc();
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("UI layout node must be an object");
  switch (node.type) {
    case "vstack":
    case "hstack":
      assertExactKeys(node as any, ["type", "children"], node.type);
      if (!Array.isArray(node.children) || node.children.length > (node.type === "vstack" ? 50 : 12)) throw new Error(`${node.type}.children invalid`);
      for (const child of node.children) validateNode(child, depth + 1, inc);
      return;
    case "grid":
      assertExactKeys(node as any, ["type", "columns", "children"], "grid");
      if (!Number.isInteger(node.columns) || node.columns < 1 || node.columns > 6) throw new Error("grid.columns must be 1..6");
      if (!Array.isArray(node.children) || node.children.length > 60) throw new Error("grid.children invalid");
      for (const child of node.children) validateNode(child, depth + 1, inc);
      return;
    case "dashboard":
      assertExactKeys(node as any, ["type", "bind"], "dashboard");
      if (node.bind) assertPointer(node.bind);
      return;
    case "text":
      assertExactKeys(node as any, ["type", "text"], "text");
      assertSafeText(node.text, "text.text");
      return;
    case "markdown":
      assertExactKeys(node as any, ["type", "bind", "text", "maxLines"], "markdown");
      if (!node.bind && !node.text) throw new Error("markdown requires bind or text");
      if (node.bind) assertPointer(node.bind);
      if (node.text) assertSafeText(node.text, "markdown.text");
      normalizePositiveInteger(node as any, "maxLines", UI_LIMITS.maxRenderedRows, "markdown.maxLines");
      return;
    case "metric":
      assertExactKeys(node as any, ["type", "label", "bind", "format", "trendBind", "threshold"], "metric");
      assertLabel(node.label, "metric.label");
      assertPointer(node.bind);
      if (node.trendBind) assertPointer(node.trendBind);
      if (node.format && !FORMATS.has(node.format)) throw new Error("metric.format invalid");
      if (node.threshold !== undefined) {
        if (!node.threshold || typeof node.threshold !== "object" || Array.isArray(node.threshold)) throw new Error("metric.threshold must be an object");
        const threshold = node.threshold as Record<string, unknown>;
        assertExactKeys(threshold, ["warnAbove", "errorAbove", "warnBelow", "errorBelow"], "metric.threshold");
        for (const key of ["warnAbove", "errorAbove", "warnBelow", "errorBelow"]) assertFiniteNumber(threshold, key, "metric.threshold");
      }
      return;
    case "progress":
      assertExactKeys(node as any, ["type", "label", "valueBind", "totalBind", "percentBind"], "progress");
      assertLabel(node.label, "progress.label");
      if (node.percentBind) assertPointer(node.percentBind);
      else if (node.valueBind && node.totalBind) {
        assertPointer(node.valueBind);
        assertPointer(node.totalBind);
      } else throw new Error("progress requires percentBind or valueBind+totalBind");
      return;
    case "sparkline":
      assertExactKeys(node as any, ["type", "label", "bind", "format", "maxPoints"], "sparkline");
      assertLabel(node.label, "sparkline.label");
      assertPointer(node.bind);
      if (node.format && !SPARKLINE_FORMATS.has(node.format)) throw new Error("sparkline.format invalid");
      normalizePositiveInteger(node as any, "maxPoints", UI_LIMITS.maxSeriesPoints, "sparkline.maxPoints");
      return;
    case "table":
      assertExactKeys(node as any, ["type", "bind", "columns", "maxRows"], "table");
      assertPointer(node.bind);
      normalizePositiveInteger(node as any, "maxRows", UI_LIMITS.maxRenderedRows, "table.maxRows");
      if (!Array.isArray(node.columns) || node.columns.length < 1 || node.columns.length > 12) throw new Error("table.columns invalid");
      for (const col of node.columns) {
        assertExactKeys(col as any, ["path", "key", "label", "format", "width"], "table.column");
        normalizeTableColumnPath(col as any);
        assertLabel(col.label, "table.column.label", 60);
        if (col.format && !FORMATS.has(col.format)) throw new Error("table column format invalid");
        normalizePositiveInteger(col as any, "width", UI_LIMITS.maxColumnWidth, "table.column.width");
      }
      return;
    case "keyValue":
      assertExactKeys(node as any, ["type", "bind", "maxItems"], "keyValue");
      assertPointer(node.bind);
      normalizePositiveInteger(node as any, "maxItems", UI_LIMITS.maxRenderedRows, "keyValue.maxItems");
      return;
    case "statusList":
      assertExactKeys(node as any, ["type", "bind", "itemLabelKey", "itemStatusKey", "itemDetailKey", "maxItems"], "statusList");
      assertPointer(node.bind);
      assertOptionalDataKey(node.itemLabelKey, "statusList.itemLabelKey");
      assertOptionalDataKey(node.itemStatusKey, "statusList.itemStatusKey");
      assertOptionalDataKey(node.itemDetailKey, "statusList.itemDetailKey");
      normalizePositiveInteger(node as any, "maxItems", UI_LIMITS.maxRenderedRows, "statusList.maxItems");
      return;
    case "phaseList":
      assertExactKeys(node as any, ["type", "maxItems"], "phaseList");
      normalizePositiveInteger(node as any, "maxItems", UI_LIMITS.maxRenderedRows, "phaseList.maxItems");
      return;
    case "logTail":
      assertExactKeys(node as any, ["type", "bind", "maxLines"], "logTail");
      if (node.bind) assertPointer(node.bind);
      normalizePositiveInteger(node as any, "maxLines", UI_LIMITS.maxRenderedRows, "logTail.maxLines");
      return;
    default:
      throw new Error(`Unsupported UI node type: ${(node as any).type}`);
  }
}

function assertExactKeys(obj: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new Error(`${label} contains unsupported key ${key}`);
}

function assertPointer(pointer: string): void {
  if (typeof pointer !== "string" || !isJsonPointer(pointer)) throw new Error(`Invalid JSON Pointer: ${pointer}`);
}

function normalizeTableColumnPath(col: Record<string, unknown>): void {
  const path = col.path;
  const key = col.key;
  if (path !== undefined && key !== undefined) throw new Error("table.column must use either path or key, not both");
  if (path !== undefined) {
    assertPointer(path as string);
    return;
  }
  if (key === undefined) throw new Error("table.column requires path or key");
  if (typeof key !== "string" || key.trim() === "") throw new Error("table.column.key must be a non-empty string");
  const pointer = key.startsWith("/") ? key : `/${key.split(".").map(encodePointerSegment).join("/")}`;
  assertPointer(pointer);
  col.path = pointer;
  delete col.key;
}

function encodePointerSegment(segment: string): string {
  if (segment === "") throw new Error("table.column.key contains an empty path segment");
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function assertLabel(value: unknown, label: string, max = 80): void {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} must be a string <= ${max} chars`);
  assertSafeText(value, label);
}

function assertOptionalDataKey(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`${label} invalid`);
}

function assertSafeText(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (stripAnsi(value) !== value) throw new Error(`${label} may not contain ANSI escape sequences`);
  if (byteLength(value) > UI_LIMITS.maxTextBytesPerNode) throw new Error(`${label} is too large`);
}
