import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import type { WorkflowJournalEvent, WorkflowUsage } from "../types.js";
import { isThinkingLevel, type ThinkingLevel } from "../thinking.js";
import { byteLength } from "../utils/truncate.js";
import { ensureDir } from "./paths.js";
import { normalizeSafeRelativePath, readBoundedTextFile, safeResolveExistingFile } from "./safe-paths.js";

export interface JournalWriter {
  append(event: WorkflowJournalEvent): Promise<void>;
}

export class JsonlJournal implements JournalWriter {
  constructor(public readonly filePath: string) {}

  async append(event: WorkflowJournalEvent): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const line = `${JSON.stringify(event)}\n`;
    const bytes = byteLength(line);
    if (bytes > WORKFLOW_RESOURCE_LIMITS.journalEventBytes) throw new Error(`Workflow journal event exceeds ${WORKFLOW_RESOURCE_LIMITS.journalEventBytes} bytes`);
    const size = await fileSize(this.filePath);
    if (size + bytes > WORKFLOW_RESOURCE_LIMITS.journalBytes) throw new Error(`Workflow journal quota exceeded (${WORKFLOW_RESOURCE_LIMITS.journalBytes} bytes)`);
    await fs.promises.appendFile(this.filePath, line, "utf8");
  }

  async readAll(): Promise<WorkflowJournalEvent[]> {
    let text = "";
    try {
      text = await readBoundedTextFile(this.filePath, WORKFLOW_RESOURCE_LIMITS.journalBytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const events: WorkflowJournalEvent[] = [];
    let lineStart = 0;
    let lineNumber = 1;
    while (lineStart <= text.length) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const line = text.slice(lineStart, lineEnd);
      if (byteLength(line) > WORKFLOW_RESOURCE_LIMITS.journalEventBytes) throw new Error(`Workflow journal event exceeds ${WORKFLOW_RESOURCE_LIMITS.journalEventBytes} bytes on line ${lineNumber}`);
      if (line.trim()) {
        if (events.length >= WORKFLOW_RESOURCE_LIMITS.journalEvents) throw new Error(`Workflow journal event count exceeds ${WORKFLOW_RESOURCE_LIMITS.journalEvents}`);
        try {
          events.push(JSON.parse(line) as WorkflowJournalEvent);
        } catch (err) {
          throw new Error(`Invalid journal JSON on line ${lineNumber}: ${(err as Error).message}`);
        }
      }
      if (newline === -1) break;
      lineStart = newline + 1;
      lineNumber++;
    }
    return events;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export interface ReplayEntry {
  event: Extract<WorkflowJournalEvent, { type: "agent_result" }>;
  resultPath: string;
}

export type ReplayStatus = "done" | "skipped" | "cached";

export class ResumeIndex {
  private readonly results = new Map<string, ReplayEntry>();
  private replayEnabled = true;

  static async fromRun(runDir: string, journalPath: string): Promise<ResumeIndex> {
    const index = new ResumeIndex(runDir);
    const journal = new JsonlJournal(journalPath);
    for (const event of await journal.readAll()) {
      if (event.type !== "agent_result") continue;
      if (!isReplayableAgentResult(event.status) || !event.resultPath) continue;
      const resultPath = await resolveReplayResultPath(runDir, event);
      if (!resultPath) continue;
      index.results.set(event.chainKey, { event, resultPath });
    }
    return index;
  }

  private readonly sourceRunDir: string;

  constructor(sourceRunDir: string) {
    this.sourceRunDir = path.resolve(sourceRunDir);
  }

  canReplay(chainKey: string): boolean {
    return this.replayEnabled && this.results.has(chainKey);
  }

  async load(chainKey: string): Promise<{ value: unknown; sourcePath: string; status: ReplayStatus; usage?: WorkflowUsage; model?: string; thinking?: ThinkingLevel } | undefined> {
    if (!this.canReplay(chainKey)) return undefined;
    const entry = this.results.get(chainKey)!;
    const relativePath = path.relative(this.sourceRunDir, entry.resultPath).split(path.sep).join("/");
    const resolved = await safeResolveExistingFile(this.sourceRunDir, relativePath, { maxBytes: WORKFLOW_RESOURCE_LIMITS.workflowReplayResultBytes });
    if (!resolved) return undefined;
    let parsed: { result?: unknown; status?: ReplayStatus; usage?: unknown; model?: unknown; thinking?: unknown };
    try {
      parsed = JSON.parse(await readBoundedTextFile(resolved.path, WORKFLOW_RESOURCE_LIMITS.workflowReplayResultBytes)) as { result?: unknown; status?: ReplayStatus; usage?: unknown; model?: unknown; thinking?: unknown };
    } catch {
      return undefined;
    }
    const status = parsed.status === "skipped" || entry.event.status === "skipped" ? "skipped" : entry.event.status === "cached" ? "cached" : "done";
    const usage = normalizeUsage(entry.event.usage) ?? normalizeUsage(parsed.usage);
    const model = typeof entry.event.model === "string" && entry.event.model.trim() ? entry.event.model : typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : undefined;
    const thinking = isThinkingLevel(entry.event.thinking) ? entry.event.thinking : isThinkingLevel(parsed.thinking) ? parsed.thinking : undefined;
    return { value: parsed.result ?? null, sourcePath: resolved.path, status, usage, model, thinking };
  }

  disableAfterFirstMiss(): void {
    this.replayEnabled = false;
  }

  getSourceRunDir(): string {
    return this.sourceRunDir;
  }
}

async function resolveReplayResultPath(runDir: string, event: Extract<WorkflowJournalEvent, { type: "agent_result" }>): Promise<string | undefined> {
  if (typeof event.callId !== "string" || !/^\d+$/.test(event.callId)) return undefined;
  const normalized = normalizeSafeRelativePath(event.resultPath);
  if (normalized !== `subagents/${event.callId}/result.json`) return undefined;
  return (await safeResolveExistingFile(runDir, normalized, { maxBytes: WORKFLOW_RESOURCE_LIMITS.workflowReplayResultBytes }))?.path;
}

function isReplayableAgentResult(status: Extract<WorkflowJournalEvent, { type: "agent_result" }>["status"]): boolean {
  return status === "done" || status === "skipped" || status === "cached";
}

function normalizeUsage(value: unknown): WorkflowUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const agentCount = finiteNonNegativeInteger(object.agentCount);
  const subagentTokens = finiteNonNegativeInteger(object.subagentTokens);
  const toolUses = finiteNonNegativeInteger(object.toolUses);
  if (agentCount === undefined || subagentTokens === undefined || toolUses === undefined) return undefined;
  const usage: WorkflowUsage = { agentCount, subagentTokens, toolUses };
  const durationMs = finiteNonNegativeInteger(object.durationMs);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  if (typeof object.estimated === "boolean") usage.estimated = object.estimated;
  return usage;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value);
}
