declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export const createReadTool: any;
  export const createWriteTool: any;
  export const createEditTool: any;
  export const DEFAULT_MAX_BYTES: number;
  export const DEFAULT_MAX_LINES: number;
  export function formatSize(bytes: number): string;
  export function keyHint(keybinding: string, description: string): string;
}

declare module "@earendil-works/pi-tui" {
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
