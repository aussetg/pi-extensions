# pi-rich-tool-renderers

Rich renderers for Pi's built-in file tools:

- `read`: Pierre line-numbered code view with tree-sitter highlighting.
- `write`: Pierre create/update diff preview.
- `edit`: Pierre diff preview from the built-in numbered diff.
- `write` / `edit`: renders `pi-code-feedback` details in the same panel style as `apply_patch`.
- Collapsed views follow Pi's built-in 10-line preview behavior; expand the tool row to show the full rendered content.

The extension delegates execution to Pi's built-in `createReadTool`, `createWriteTool`, and `createEditTool`; only rendering and write-preview snapshotting are added.

Performance notes:

- Payloads and write snapshots use one shared bounded LRU cache for all three tools.
- Pierre's own highlight/row caches are reused across all rendered default-tool diffs.
- Collapsed `read` and new-file `write` previews only build/highlight the first 10 lines.
- Large write diffs are skipped instead of reading or diffing huge files.
