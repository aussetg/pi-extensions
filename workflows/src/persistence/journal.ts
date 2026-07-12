import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import type { WorkflowJournalEvent } from "../types.js";
import { byteLength } from "../utils/truncate.js";
import { ensureDir } from "./paths.js";
import { readBoundedTextFile } from "./safe-paths.js";

export interface JournalWriter {
  append(event: WorkflowJournalEvent): Promise<void>;
}

const appendQueues = new Map<string, Promise<void>>();

export class JsonlJournal implements JournalWriter {
  constructor(public readonly filePath: string) {}

  append(event: WorkflowJournalEvent): Promise<void> {
    const key = path.resolve(this.filePath);
    const previous = appendQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.appendNow(event));
    appendQueues.set(key, next);
    void next.then(
      () => {
        if (appendQueues.get(key) === next) appendQueues.delete(key);
      },
      () => {
        if (appendQueues.get(key) === next) appendQueues.delete(key);
      },
    );
    return next;
  }

  private async appendNow(event: WorkflowJournalEvent): Promise<void> {
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
