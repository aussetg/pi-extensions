import fs from "node:fs";
import path from "node:path";
import type { WorkflowJournalEvent, WorkflowUsage } from "../types.js";
import { ensureDir } from "./paths.js";

export interface JournalWriter {
  append(event: WorkflowJournalEvent): Promise<void>;
}

export class JsonlJournal implements JournalWriter {
  constructor(public readonly filePath: string) {}

  async append(event: WorkflowJournalEvent): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await fs.promises.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readAll(): Promise<WorkflowJournalEvent[]> {
    let text = "";
    try {
      text = await fs.promises.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const events: WorkflowJournalEvent[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as WorkflowJournalEvent);
      } catch (err) {
        throw new Error(`Invalid journal JSON on line ${index + 1}: ${(err as Error).message}`);
      }
    }
    return events;
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
      index.results.set(event.chainKey, { event, resultPath: path.resolve(runDir, event.resultPath) });
    }
    return index;
  }

  constructor(private readonly sourceRunDir: string) {}

  canReplay(chainKey: string): boolean {
    return this.replayEnabled && this.results.has(chainKey);
  }

  async load(chainKey: string): Promise<{ value: unknown; sourcePath: string; status: ReplayStatus; usage?: WorkflowUsage; model?: string } | undefined> {
    if (!this.canReplay(chainKey)) return undefined;
    const entry = this.results.get(chainKey)!;
    const text = await fs.promises.readFile(entry.resultPath, "utf8");
    const parsed = JSON.parse(text) as { result?: unknown; status?: ReplayStatus; usage?: unknown; model?: unknown };
    const status = parsed.status === "skipped" || entry.event.status === "skipped" ? "skipped" : entry.event.status === "cached" ? "cached" : "done";
    const usage = normalizeUsage(entry.event.usage) ?? normalizeUsage(parsed.usage);
    const model = typeof entry.event.model === "string" && entry.event.model.trim() ? entry.event.model : typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : undefined;
    return { value: parsed.result ?? null, sourcePath: entry.resultPath, status, usage, model };
  }

  disableAfterFirstMiss(): void {
    this.replayEnabled = false;
  }

  getSourceRunDir(): string {
    return this.sourceRunDir;
  }
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
