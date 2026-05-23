import { resetPierreHighlightCache } from "./highlight-cache.ts";
import { resetPierreHighlighter } from "./highlight.ts";
import { resetPierreRowCache } from "./rows.ts";
import { resetSharedSyntaxService } from "./syntax-service.ts";

export function resetPierreRendererState(): void {
  resetPierreHighlighter();
  resetPierreHighlightCache();
  resetPierreRowCache();
  resetSharedSyntaxService();
}
