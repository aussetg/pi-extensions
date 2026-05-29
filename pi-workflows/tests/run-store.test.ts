import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/persistence/run-store.js";

const meta = { name: "x", description: "test workflow" };
const source = "export const meta = { name: 'x', description: 'test workflow' };\nreturn 'ok';\n";

let oldAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-run-store-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("RunStore cwd scoping", () => {
  it("lists and gets only runs from the active cwd root", async () => {
    const cwdA = path.join(tmp, "a");
    const cwdB = path.join(tmp, "b");
    await fs.promises.mkdir(cwdA, { recursive: true });
    await fs.promises.mkdir(cwdB, { recursive: true });

    const store = new RunStore();
    const a = await store.create({ cwd: cwdA, sessionId: "s", meta, source, args: {} });
    const b = await store.create({ cwd: cwdB, sessionId: "s", meta, source, args: {} });

    await store.refresh(cwdA);
    expect(store.list("all").map((run) => run.runId)).toEqual([a.record.runId]);
    expect(store.get(a.record.runId)?.runId).toBe(a.record.runId);
    expect(store.get(b.record.runId)).toBeUndefined();

    await store.refresh(cwdB);
    expect(store.list("all").map((run) => run.runId)).toEqual([b.record.runId]);
    expect(store.get(a.record.runId)).toBeUndefined();
    expect(store.get(b.record.runId)?.runId).toBe(b.record.runId);
  });

  it("marks stale runs only for the requested cwd root", async () => {
    const cwdA = path.join(tmp, "a");
    const cwdB = path.join(tmp, "b");
    await fs.promises.mkdir(cwdA, { recursive: true });
    await fs.promises.mkdir(cwdB, { recursive: true });

    const store = new RunStore();
    const a = await store.create({ cwd: cwdA, sessionId: "s", meta, source, args: {} });
    const b = await store.create({ cwd: cwdB, sessionId: "s", meta, source, args: {} });

    await expect(store.markStaleRunsForSession(cwdA)).resolves.toBe(1);
    expect(JSON.parse(await fs.promises.readFile(path.join(a.runDir, "run.json"), "utf8")).status).toBe("stale");
    expect(JSON.parse(await fs.promises.readFile(path.join(b.runDir, "run.json"), "utf8")).status).toBe("running");
  });
});

describe("RunStore serialized saves", () => {
  it("flushes debounced progress saves before terminal saves", async () => {
    const cwd = path.join(tmp, "serial");
    await fs.promises.mkdir(cwd, { recursive: true });

    const store = new RunStore();
    const { record, runDir } = await store.create({ cwd, sessionId: "s", meta, source, args: {} });

    record.progress.total = 7;
    store.scheduleSave(record, 60_000);
    await store.flush(record.runId);
    expect(JSON.parse(await fs.promises.readFile(path.join(runDir, "run.json"), "utf8")).progress.total).toBe(7);

    record.status = "completed";
    record.endedAt = new Date(0).toISOString();
    await store.saveNow(record);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.parse(await fs.promises.readFile(path.join(runDir, "run.json"), "utf8")).status).toBe("completed");
  });

  it("serializes queued writes so older saves cannot finish after newer saves", async () => {
    const cwd = path.join(tmp, "queue");
    await fs.promises.mkdir(cwd, { recursive: true });

    const store = new RunStore();
    const { record, runDir } = await store.create({ cwd, sessionId: "s", meta, source, args: {} });
    const runJson = path.join(runDir, "run.json");

    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    void store.enqueueSave(record.runId, async () => {
      await firstCanFinish;
      await fs.promises.writeFile(runJson, `${JSON.stringify({ ...record, status: "running" }, null, 2)}\n`, "utf8");
    });

    record.status = "completed";
    const finalSave = store.saveNow(record);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await finalSave;

    expect(JSON.parse(await fs.promises.readFile(runJson, "utf8")).status).toBe("completed");
  });

  it("writes run records atomically without leaving temp files", async () => {
    const cwd = path.join(tmp, "atomic");
    await fs.promises.mkdir(cwd, { recursive: true });

    const store = new RunStore();
    const { record, runDir } = await store.create({ cwd, sessionId: "s", meta, source, args: {} });
    record.status = "completed";
    await store.saveNow(record);

    const leftovers = (await fs.promises.readdir(runDir)).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("RunStore live run lifecycle", () => {
  it("stops live session runs, suppresses completion, and marks records aborted", async () => {
    const cwd = path.join(tmp, "live");
    await fs.promises.mkdir(cwd, { recursive: true });

    const store = new RunStore();
    const { record, runDir } = await store.create({ cwd, sessionId: "session-a", meta, source, args: { q: "x" } });
    const stopped: string[] = [];
    const control = {
      pause: () => undefined,
      resume: () => undefined,
      stop: (reason?: string) => stopped.push(reason ?? ""),
      skipAgent: () => false,
      retryAgent: () => false,
    };

    store.registerLiveRun({ runId: record.runId, sessionId: "session-a", control, donePromise: new Promise(() => undefined), notifyOnComplete: true });

    await expect(store.stopLiveRunsForSession("session-a", "reload")).resolves.toBe(1);
    expect(stopped).toEqual(["reload"]);
    expect(store.shouldNotifyOnComplete(record.runId)).toBe(false);
    expect(JSON.parse(await fs.promises.readFile(path.join(runDir, "run.json"), "utf8"))).toEqual(
      expect.objectContaining({
        status: "aborted",
        recovery: expect.objectContaining({ scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: { q: "x" } }),
      }),
    );
  });

  it("only stops live runs for the requested session", async () => {
    const cwd = path.join(tmp, "live-filter");
    await fs.promises.mkdir(cwd, { recursive: true });

    const store = new RunStore();
    const a = await store.create({ cwd, sessionId: "session-a", meta, source, args: {} });
    const b = await store.create({ cwd, sessionId: "session-b", meta, source, args: {} });
    const stopped: string[] = [];
    const control = (id: string) => ({
      pause: () => undefined,
      resume: () => undefined,
      stop: () => stopped.push(id),
      skipAgent: () => false,
      retryAgent: () => false,
    });

    store.registerLiveRun({ runId: a.record.runId, sessionId: "session-a", control: control("a"), donePromise: new Promise(() => undefined), notifyOnComplete: true });
    store.registerLiveRun({ runId: b.record.runId, sessionId: "session-b", control: control("b"), donePromise: new Promise(() => undefined), notifyOnComplete: true });

    await expect(store.stopLiveRunsForSession("session-a")).resolves.toBe(1);
    expect(stopped).toEqual(["a"]);
    expect(store.shouldNotifyOnComplete(a.record.runId)).toBe(false);
    expect(store.shouldNotifyOnComplete(b.record.runId)).toBe(true);
  });
});
