// Types used for tool progress, application, and result reporting.

import type { PierreDiffPayload } from "./pierre/types.ts";

export type ApplyPatchOpType = "create_file" | "update_file" | "delete_file";

export interface ApplyPatchOperation {
  type: ApplyPatchOpType;
  path: string;
  /**
   * Codex apply_patch section body, not a full *** Begin/End Patch envelope.
   * - create_file: Add File body; every content line starts with '+'
   * - update_file: Update File hunks; @@ sections with +/-/space lines
   */
  diff?: string;
  /** Optional move target, equivalent to Codex's `*** Move to:` subheader. */
  move_path?: string;
}

export interface ApplyPatchPreview {
  path: string;
  diff: string;
  firstChangedLine?: number;
  pierre?: PierreDiffPayload;
}

export type ApplyPatchDetails =
  | {
      stage: "progress";
      message: string;
      previewPath?: string;
      previewDiff?: string;
    }
  | {
      stage: "done";
      fuzz: number;
      results: Array<{
        type: ApplyPatchOpType;
        path: string;
        status: "completed" | "failed";
        output?: string;
        diff?: string;
        firstChangedLine?: number;
        pierre?: PierreDiffPayload;
      }>;
      previews?: ApplyPatchPreview[];
      warnings?: string[];
    };

export interface LineReplacement {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}
