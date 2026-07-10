declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type AgentToolUpdateCallback<T = unknown> = (update: {
    content?: unknown;
    details?: T;
  }) => void;
  export const createReadToolDefinition: any;
  export const createWriteToolDefinition: any;
  export const createEditToolDefinition: any;
  export const createReadTool: any;
  export const createBashTool: any;
  export const createWriteTool: any;
  export const createEditTool: any;
  export const DEFAULT_MAX_BYTES: number;
  export const DEFAULT_MAX_LINES: number;
  export interface TruncationResult {
    content: string;
    truncated: boolean;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
  }
  export function formatSize(bytes: number): string;
  export function keyHint(keybinding: string, description: string): string;
  export function keyText(keybinding: string): string;
  export function truncateHead(
    text: string,
    options?: { maxLines?: number; maxBytes?: number },
  ): TruncationResult;
  export function withFileMutationQueue<T>(
    path: string,
    mutation: () => T | Promise<T>,
  ): Promise<T>;
}

declare module "@earendil-works/pi-tui" {
  export function getCapabilities(): { images: "kitty" | "iterm2" | null };
  export function getImageDimensions(
    base64Data: string,
    mimeType: string,
  ): { widthPx: number; heightPx: number } | null;
  export function imageFallback(
    mimeType: string,
    dimensions?: { widthPx: number; heightPx: number },
    filename?: string,
  ): string;
  export function truncateToWidth(text: string, width: number, suffix?: string): string;
  export function visibleWidth(text: string): number;
  export function wrapTextWithAnsi(text: string, width: number): string[];

  export interface Component {
    render(width: number): string[];
    invalidate?(): void;
  }

  export class Text implements Component {
    constructor(
      text: string,
      paddingX?: number,
      paddingY?: number,
      background?: (text: string) => string,
    );
    setText(text: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class Image implements Component {
    constructor(
      data: string,
      mimeType: string,
      theme?: unknown,
      options?: { maxWidthCells?: number; maxHeightCells?: number },
    );
    render(width: number): string[];
    invalidate(): void;
  }
}

declare module "@earendil-works/pi-ai" {
  export const StringEnum: any;
}

declare module "typebox" {
  export const Type: any;
}
