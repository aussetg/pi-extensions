import type { ComponentLike } from "./simple-components.js";
import type { WorkflowViewSnapshot } from "../types.js";
import { WorkflowViewRenderer, type WorkflowViewRenderProfile } from "./workflow-view-renderer.js";
import { padToWidth } from "../utils/truncate.js";

export class WorkflowViewComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedSeq?: number;
  private cachedLines?: string[];

  constructor(private snapshot: WorkflowViewSnapshot, private readonly renderer: WorkflowViewRenderer, private readonly profile: WorkflowViewRenderProfile = "full") {}

  update(snapshot: WorkflowViewSnapshot): void {
    this.snapshot = snapshot;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedSeq === this.snapshot.seq) return this.cachedLines;
    const lines = this.renderer.render(this.snapshot, width, this.profile).map((line) => padToWidth(line, width));
    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedSeq = this.snapshot.seq;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
    this.cachedSeq = undefined;
  }
}
