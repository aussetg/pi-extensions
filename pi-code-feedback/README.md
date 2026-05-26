# pi-code-feedback

Pi extension for touched-line LSP diagnostics and formatter feedback.

The package currently registers `/lsp`, the `lsp` tool, footer status, touched-range capture for `write`, `edit`, and `apply_patch`, real stdio LSP clients, LSP diagnostics/navigation requests, touched-range-filtered inline diagnostic feedback, pretty LSP result rendering, safe text-edit application for `rename` / selected code actions, immediate automatic formatting with touched-range remapping before diagnostics, and delayed context injection for slow LSP diagnostics.

The intended agent-facing tool is `lsp`; the human interface is `/lsp status`, `/lsp enable`, `/lsp disable`, `/lsp restart`, and `/lsp trust ...` for session-persisted external language-environment roots. Formatting stays in the automatic feedback pipeline, not under LSP.

The inherited pi process `PATH` is treated as trusted baseline; `/lsp trust` extends filesystem roots searched for language environments such as Python `.venv` / uv / conda envs, and those roots act as LSP/formatter workspaces for files inside them.

The `lsp` tool now uses an LSP-lite API: pass `method` with names such as `server/status`, `textDocument/hover`, `textDocument/diagnostic`, `workspace/symbol`, `textDocument/codeAction`, and `codeAction/apply`. Position-scoped methods require positive 1-based integers (`line`, `column`) to match file reads. The old `action` field remains as a compatibility alias.

Interactive rendering is method-aware: the tool row shows the requested LSP method and target, large results are collapsed in the UI, hover code fences are stripped to raw text, and agent-visible text is truncated to 2000 lines or 50KB with the full output saved to a temp file.

Automatic formatting is deterministic: one configured/canonical formatter per file, disclosed only when it changes the file or fails.

If a language server answers after the inline tool-result timeout, linked diagnostics are queued once and injected before the next model request.

Diagnostic refreshes are queued globally and run across different files with a default concurrency of 4, while refreshes for the same file stay ordered so LSP document versions do not race. Override with `--code-feedback-lsp-concurrency=<1-16>`.

Inline feedback is appended to `result.content` for the model and mirrored as structured metadata under `result.details.piCodeFeedback` for renderers.

For languages with multiple configured servers, diagnostics and read-only `/lsp` requests fan out across the matching servers; code actions are tagged with their source server and listed with session-local ids, resolving deferred edits only when `codeAction/apply` applies the selected action.

