export type NoticeLevel = "info" | "warning" | "error";

export interface PiFlagDefinition {
  description: string;
  type: "boolean" | "string";
  default?: boolean | string;
}

export interface PiUi {
  notify(message: string, level?: NoticeLevel): void;
  setStatus?: (id: string, text: string | undefined) => void;
  theme?: {
    fg?: (color: string, text: string) => string;
  };
}

export interface PiCommandContext {
  cwd?: string;
  ui: PiUi;
  sessionManager?: PiSessionManager;
  reload?: () => Promise<void>;
}

export interface PiToolContext {
  cwd?: string;
}

export interface PiCommandDefinition {
  description: string;
  handler(args: unknown, ctx: PiCommandContext): Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }> | null;
}

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: unknown;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  renderShell?: "self";
  renderCall?: (args: Record<string, unknown>, theme: any, context: any) => unknown;
  renderResult?: (result: PiToolResult, options: any, theme: any, context: any) => unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: Partial<PiToolResult>) => void,
    ctx?: PiToolContext,
  ): Promise<PiToolResult> | PiToolResult;
}

export interface PiApi {
  registerFlag?: (name: string, definition: PiFlagDefinition) => void;
  getFlag?: (name: string) => boolean | string | undefined;
  appendEntry?: (customType: string, data?: unknown) => void;
  registerCommand: (name: string, definition: PiCommandDefinition) => void;
  registerTool: (definition: PiToolDefinition) => void;
  on?: (eventName: string, handler: (event: unknown, ctx: PiCommandContext) => unknown) => void;
}

export interface PiSessionManager {
  getEntries?: () => unknown[];
  getBranch?: () => unknown[];
  getSessionFile?: () => string | undefined;
}

export function asPiApi(value: unknown): PiApi {
  return value as PiApi;
}

