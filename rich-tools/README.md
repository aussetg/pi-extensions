# rich-tools

One Pi extension for rich model-facing tools and richer built-in tool rendering:

- model-aware tool profiles: OpenAI-family models get `bash` / `apply_patch` / `view_image`, while other families keep Pi's native tools.
- `web_search`: searches the web through Kagi Search, with result workflows, lenses, filters, personalizations, pagination, and optional inline extraction.
- `web_fetch`: extracts markdown from up to ten web pages through Kagi Extract.
- `read_image`: delegates image analysis to a vision-capable model when the active model cannot see images.
- `apply_patch`: structured or envelope file edits with Pierre diff previews.
- `read`: Pierre line-numbered code view with tree-sitter/TextMate highlighting.
- `write`: Pierre create/update diff preview.
- `edit`: Pierre diff preview from the built-in numbered diff.
- `write` / `edit` / `apply_patch`: renders `code-feedback` directly on the settled edit surface beneath the preview.
- `bash`: classifies read/list/search shell commands and renders them as `Exploring` / `Explored` instead of generic runs.
- `bash`: visually coalesces adjacent exploratory bash calls into one UI block, including resumed session history, without changing stored tool history or model context.
- `bash`: captures TTY colors for the live UI through a PTY, then strips ANSI/PTY artifacts from tool results and full-output logs before they can reach model context.
- `bash`: squashes binary-looking output lines and visualizes terminal control characters instead of letting them leak into the TUI/model context.
- `bash`: appends the structured `exitCode` to model-visible output, while keeping the TUI view compact.
- `bash`: runs tool commands through `/bin/bash -c`, regardless of the user's login shell.
- `bash`: uses PTY/color capture only for recognized read/list/search commands; unknown commands run in plain non-interactive mode to avoid unbounded TTY spinner/control output.

- Collapsed views follow Pi's built-in 10-line preview behavior; `read` counts rendered terminal lines, and expanding the tool row shows the full rendered content.

Pi currently customizes built-in tool rendering by re-registering the tool name. This extension does that with delegating overrides: it starts from Pi's own `createBashTool`, `createReadToolDefinition`, `createWriteToolDefinition`, and `createEditToolDefinition`, preserves their execution/argument/prompt metadata, and only replaces rendering plus a small bash spawn hook for PTY color capture.

`write` previews are snapshotted from the `tool_call` event before Pi's original `write` implementation runs; the snapshot is only used for rendering the diff preview.

Performance notes:

- Payloads and write snapshots use one shared bounded LRU cache for all three tools.
- Pierre's own highlight/row caches are reused across all rendered default-tool diffs and bounded
  by both entry count and estimated retained bytes (24 MiB for highlights, 32 MiB for rows).
  Override those byte budgets with `PI_RICH_TOOLS_PIERRE_HIGHLIGHT_CACHE_MAX_BYTES` and
  `PI_RICH_TOOLS_PIERRE_ROW_CACHE_MAX_BYTES`.
- Collapsed `read` previews count rendered terminal lines with a lightweight width scan and only materialize the first 10; collapsed new-file `write` previews only build/highlight the first 10 content lines.
- Large write diffs are skipped instead of reading or diffing huge files.
- Syntax highlighting runs entirely in one persistent child process: tree-sitter first, then
  TextMate/Shiki for unsupported or sparsely captured syntax. The TUI paints plain diff rows
  immediately and replaces them with highlighted rows when the worker replies; parsing,
  tokenization, and grammar loading never run in Pi's render process. Set
  `PI_PIERRE_HIGHLIGHT_WORKER_TIMEOUT_MS` to change the 5-second request timeout or
  `PI_PIERRE_HIGHLIGHT_NODE` to choose the worker's Node executable.

## Kagi authentication

Put the API key in `~/.pi/agent/kagi.json`:

```json
{ "apiKey": "..." }
```

`KAGI_API_KEY` is used as a fallback. Set `KAGI_CONFIG_FILE` to use a different config file.
