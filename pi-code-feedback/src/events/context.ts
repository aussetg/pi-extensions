import { renderDelayedContextMessage } from "../render.ts";
import { consumeDelayedFeedback, type CodeFeedbackRuntime } from "../runtime.ts";

export interface ContextEvent {
  messages?: Array<{ role: string; content: unknown; timestamp?: number }>;
}

export interface ContextResult {
  messages: Array<{ role: string; content: unknown; timestamp?: number }>;
}

export function handleContext(event: ContextEvent, runtime: CodeFeedbackRuntime): ContextResult | void {
  if (!runtime.config.enabled || !runtime.config.lsp.enabled) return;
  if (!runtime.projectTrusted) return;

  const delayed = consumeDelayedFeedback(runtime, 3);
  if (delayed.length === 0) return;

  const existingMessages = Array.isArray(event.messages) ? event.messages : [];
  const injected = {
    role: "user",
    content: renderDelayedContextMessage(delayed),
    timestamp: Date.now(),
  };

  // Prepend so the real current user request remains the final user message.
  return { messages: [injected, ...existingMessages] };
}
