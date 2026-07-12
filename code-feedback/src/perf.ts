import { performance } from "node:perf_hooks";
import type { CodeFeedbackTiming, CodeFeedbackTimingPhase } from "./types.ts";

export interface TimingRecorder {
  readonly phases: CodeFeedbackTimingPhase[];
  measure<T>(name: string, run: () => T): T;
  measureAsync<T>(name: string, run: () => Promise<T>): Promise<T>;
  snapshot(): CodeFeedbackTiming;
}

export function createTimingRecorder(seed?: CodeFeedbackTiming): TimingRecorder {
  const phases = seed?.phases.map((phase) => ({ ...phase })) ?? [];

  return {
    phases,
    measure<T>(name: string, run: () => T): T {
      const startedAt = performance.now();
      try {
        return run();
      } finally {
        phases.push({ name, durationMs: elapsedMs(startedAt) });
      }
    },
    async measureAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
      const startedAt = performance.now();
      try {
        return await run();
      } finally {
        phases.push({ name, durationMs: elapsedMs(startedAt) });
      }
    },
    snapshot(): CodeFeedbackTiming {
      return summarizeTiming(phases);
    },
  };
}

export function addTimingPhase(timing: CodeFeedbackTiming | undefined, name: string, durationMs: number): CodeFeedbackTiming {
  const phases = [...(timing?.phases ?? []), { name, durationMs: roundMs(durationMs) }];
  return summarizeTiming(phases);
}

export function summarizeTiming(phases: CodeFeedbackTimingPhase[]): CodeFeedbackTiming {
  const copied = phases.map((phase) => ({ name: phase.name, durationMs: roundMs(phase.durationMs) }));
  return {
    totalMs: roundMs(copied.reduce((sum, phase) => sum + phase.durationMs, 0)),
    phases: copied,
  };
}

function elapsedMs(startedAt: number): number {
  return roundMs(performance.now() - startedAt);
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}
