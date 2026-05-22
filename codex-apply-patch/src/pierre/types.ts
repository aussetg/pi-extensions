import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";

export type PierreAppearance = "dark" | "light";

export interface HastTextNode {
  type: "text";
  value: string;
}

export interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export type HastNode = HastTextNode | HastElementNode;

export interface HighlightedDiffCode {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
}

export type HighlightedDiffSet = Record<PierreAppearance, HighlightedDiffCode>;

export interface PierreDiffPayload {
  path: string;
  metadata: FileDiffMetadata;
  highlighted?: HighlightedDiffSet;
}

export interface DiffSpan {
  text: string;
  fg?: string;
  bg?: string;
}

export type DiffRow =
  | {
      kind: "collapsed" | "metadata";
      text: string;
      fg: string;
      bg: string;
    }
  | {
      kind: "line";
      lineType: "context" | "addition" | "deletion";
      lineNumber?: number;
      spans: DiffSpan[];
      rowFg: string;
      rowBg: string;
      lineNumberFg: string;
    };

export function emptyHighlightedDiffSet(): HighlightedDiffSet {
  return {
    dark: { deletionLines: [], additionLines: [] },
    light: { deletionLines: [], additionLines: [] },
  };
}
