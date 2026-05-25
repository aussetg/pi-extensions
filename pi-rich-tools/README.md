# pi-rich-tools

One Pi extension for rich model-facing tools and richer built-in tool rendering:

- model-aware tool profiles: OpenAI-family models get `bash` / `apply_patch` / `view_image`, while other families keep Pi's native tools.
- `apply_patch`: structured or envelope file edits with Pierre diff previews.
- `read`: Pierre line-numbered code view with tree-sitter/TextMate highlighting.
- `write`: Pierre create/update diff preview.
- `edit`: Pierre diff preview from the built-in numbered diff.
- `write` / `edit` / `apply_patch`: renders `pi-code-feedback` details in the same panel style.
- `bash`: classifies read/list/search shell commands and renders them as `Exploring` / `Explored` instead of generic runs.
- `bash`: visually coalesces adjacent exploratory bash calls into one UI block, including resumed session history, without changing stored tool history or model context.
- `bash`: captures TTY colors for the live UI through a PTY, then strips ANSI/PTY artifacts from tool results and full-output logs before they can reach model context.
- `bash`: squashes binary-looking output lines and visualizes terminal control characters instead of letting them leak into the TUI/model context.
- `bash`: appends the structured `exitCode` to model-visible output, while keeping the TUI view compact.
- `bash`: runs tool commands through `/bin/bash -c`, regardless of the user's login shell.

- Collapsed views follow Pi's built-in 10-line preview behavior; `read` counts rendered terminal lines, and expanding the tool row shows the full rendered content.

Pi currently customizes built-in tool rendering by re-registering the tool name. This extension does that with delegating overrides: it starts from Pi's own `createBashTool`, `createReadToolDefinition`, `createWriteToolDefinition`, and `createEditToolDefinition`, preserves their execution/argument/prompt metadata, and only replaces rendering plus a small bash spawn hook for PTY color capture.

`write` previews are snapshotted from the `tool_call` event before Pi's original `write` implementation runs; the snapshot is only used for rendering the diff preview.

Performance notes:

- Payloads and write snapshots use one shared bounded LRU cache for all three tools.
- Pierre's own highlight/row caches are reused across all rendered default-tool diffs.
- Collapsed `read` previews collapse after 10 rendered terminal lines; collapsed new-file `write` previews only build/highlight the first 10 content lines.
- Large write diffs are skipped instead of reading or diffing huge files.
- Syntax highlighting uses tree-sitter first, then an async TextMate/Shiki fallback for languages outside the tree-sitter bundle.
