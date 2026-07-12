// Types used for tool progress, application, and result reporting.

export type ApplyPatchOpType = "create_file" | "update_file" | "delete_file";

export interface ApplyPatchOperation {
  type: ApplyPatchOpType;
  path: string;
  /**
   * Structured JSON form only: apply_patch section body, not a full
   * *** Begin/End Patch envelope. Full envelopes belong in the tool-level
   * `patch` argument.
   * - create_file: Add File body; every content line starts with '+'
   * - update_file: Update File hunks; @@ sections with +/-/space lines
   */
  diff?: string;
  /** Optional move target, equivalent to the `*** Move to:` subheader. */
  move_path?: string;
}

export type ApplyPatchFileChange =
  | {
      type: "add";
      content: string;
    }
  | {
      type: "delete";
      content: string;
    }
  | {
      type: "update";
      unifiedDiff: string;
      movePath?: string;
    };

export interface ApplyPatchResultEntry {
  type: ApplyPatchOpType;
  path: string;
  status: "completed" | "failed";
  output?: string;
  change?: ApplyPatchFileChange;
  firstChangedLine?: number;
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
      results: ApplyPatchResultEntry[];
      warnings?: string[];
    };

export interface LineReplacement {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}
