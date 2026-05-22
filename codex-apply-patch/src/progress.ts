import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ApplyPatchDetails } from "./types.ts";

// Emit a progress update (used by the tool renderer).
function progress(
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  message: string,
  preview?: { path?: string; diff?: string },
): void {
  onUpdate?.({
    content: [{ type: "text", text: message }],
    details: {
      stage: "progress",
      message,
      previewPath: preview?.path,
      previewDiff: preview?.diff,
    },
  });
}

export function createThrottledProgressEmitter(
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  minIntervalMs = 40,
): {
  emit: (
    message: string,
    preview?: { path?: string; diff?: string },
    force?: boolean,
  ) => void;
  flush: () => void;
} {
  if (!onUpdate) {
    return {
      emit() {
        // no-op
      },
      flush() {
        // no-op
      },
    };
  }

  let lastEmitTs = 0;
  let pending:
    | { message: string; preview?: { path?: string; diff?: string } }
    | undefined;

  const emitNow = (
    message: string,
    preview?: { path?: string; diff?: string },
  ) => {
    lastEmitTs = Date.now();
    progress(onUpdate, message, preview);
  };

  return {
    emit(message, preview, force = false) {
      if (force) {
        emitNow(message, preview);
        pending = undefined;
        return;
      }

      const now = Date.now();
      if (lastEmitTs === 0 || now - lastEmitTs >= minIntervalMs) {
        emitNow(message, preview);
        pending = undefined;
        return;
      }

      pending = { message, preview };
    },
    flush() {
      if (!pending) return;
      emitNow(pending.message, pending.preview);
      pending = undefined;
    },
  };
}

