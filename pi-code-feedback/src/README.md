# pi-code-feedback source layout

Current modules:

- `config.ts` — config files, flags, defaults
- `command-path.ts` — shared PATH / `node_modules/.bin` command resolution
- `language-environments.ts` — lightweight language toolchain detection, currently Python venv / uv / conda-style envs
- `runtime.ts` — session state, pending edits, delayed findings
- `render.ts` — compact human/agent-visible output
- `events/` — pi lifecycle handlers, including delayed diagnostic context injection
- `lsp/` — stdio LSP client/service, server detection, LSP-lite tool methods, raw tool output/truncation, safe WorkspaceEdit text-edit application, position helpers
- `diagnostics/ranges.ts` — touched-range calculation
- `diagnostics/provenance.ts` — diagnostic-to-touched-range linking
- `diagnostics/snapshots.ts` — diagnostic snapshot normalization helpers
- `format/formatters.ts` — deterministic formatter detection and command resolution
- `format/service.ts` — formatter execution and recent formatter status
- `format/mapping.ts` — touched-range remapping through formatter changes
- `commands/` — the `/lsp ...` human command
- `commands/trust.ts` — helpers for `/lsp trust ...` external language-environment roots

