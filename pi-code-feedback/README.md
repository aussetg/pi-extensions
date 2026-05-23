# pi-code-feedback

Pi extension for touched-line LSP diagnostics and formatter feedback.

The package currently registers `/lsp`, the `lsp` tool, footer status, touched-range capture for `write`, `edit`, and `apply_patch`, real stdio LSP clients, LSP diagnostics/navigation requests, touched-range-filtered inline diagnostic feedback, pretty LSP result rendering, safe text-edit application for `rename` / selected code actions, immediate automatic formatting with touched-range remapping before diagnostics, and delayed context injection for slow LSP diagnostics.

The intended agent-facing tool is `lsp`; the human interface is `/lsp status`, `/lsp enable`, `/lsp disable`, and `/lsp restart`. Formatting stays in the automatic feedback pipeline, not under LSP.

The `lsp` tool now uses an LSP-lite API: pass `method` with names such as `server/status`, `textDocument/hover`, `textDocument/diagnostic`, `workspace/symbol`, `textDocument/codeAction`, and `codeAction/apply`. Position-scoped methods require positive 1-based integers (`line`, `column`) to match file reads. The old `action` field remains as a compatibility alias.

Interactive rendering is method-aware: the tool row shows the requested LSP method and target, large results are collapsed in the UI, hover code fences are stripped to raw text, and agent-visible text is truncated to 2000 lines or 50KB with the full output saved to a temp file.

Automatic formatting is deterministic: one configured/canonical formatter per file, disclosed only when it changes the file or fails.

If a language server answers after the inline tool-result timeout, linked diagnostics are queued once and injected before the next model request.

Inline feedback is appended to `result.content` for the model and mirrored as structured metadata under `result.details.piCodeFeedback` for renderers.

For languages with multiple configured servers, diagnostics and read-only `/lsp` requests fan out across the matching servers; code actions are tagged with their source server and listed with session-local ids so `codeAction/apply` can apply the selected action directly.

