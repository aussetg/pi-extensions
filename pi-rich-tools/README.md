# pi-rich-tools

One Pi extension for the rich file-tool experience:

- `apply_patch`: Codex-compatible file edits with Pierre diff previews.
- `read`: Pierre line-numbered code view with tree-sitter highlighting.
- `write`: Pierre create/update diff preview.
- `edit`: Pierre diff preview from the built-in numbered diff.
- `write` / `edit` / `apply_patch`: renders `pi-code-feedback` details in the same panel style.

- Collapsed views follow Pi's built-in 10-line preview behavior; expand the tool row to show the full rendered content.

Pi currently customizes built-in tool rendering by re-registering the tool name. This extension does that with delegating overrides: it starts from Pi's own `createReadToolDefinition`, `createWriteToolDefinition`, and `createEditToolDefinition`, preserves their execution/argument/prompt metadata, and only replaces `renderCall` / `renderResult` / `renderShell`.

`write` previews are snapshotted from the `tool_call` event before Pi's original `write` implementation runs; the snapshot is only used for rendering the diff preview.

Performance notes:

- Payloads and write snapshots use one shared bounded LRU cache for all three tools.
- Pierre's own highlight/row caches are reused across all rendered default-tool diffs.
- Collapsed `read` and new-file `write` previews only build/highlight the first 10 lines.
- Large write diffs are skipped instead of reading or diffing huge files.
