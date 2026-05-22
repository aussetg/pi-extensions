# pi-code-feedback spec and build plan

## Intent

`pi-code-feedback` is a pi extension that makes coding agents see the same tight feedback loop a human gets from an editor: fresh LSP diagnostics, precise symbol navigation, and formatter/autofix consequences.

The central rule is low noise:

> Inline feedback after a write/edit/apply_patch must show only diagnostics linked to the lines the agent touched, unless the agent explicitly asks for more.

This is not an MVP document. It describes the target design we want to build directly: small surface area, strong internals, and no temporary architecture that we already know we will regret.

## Non-negotiables

- The extension name is `pi-code-feedback`.
- The agent-facing tool is named `lsp` and exposes LSP behavior only.
- Formatting is part of the automatic feedback pipeline and human commands, not part of the `lsp` tool.
- Inline diagnostics are provenance-filtered. Raw project noise is hidden by default.
- The implementation may break compatibility with earlier local experiments.
- Prefer clear local code over generic plugin frameworks.
- No auto-installing language servers or formatters at first. Report missing tools plainly.
- The extension must be safe to leave enabled in this extensions directory while under construction.

## User-visible behavior

After a successful `write`, `edit`, or `apply_patch`, the original tool result is preserved and a compact block may be appended:

```text
pi-code-feedback:
  formatted: biome changed file
  touched diagnostics: 1 error, 1 warning

  ERROR src/api.ts:42:17 TS2345
    Argument of type 'string | undefined' is not assignable to parameter of type 'string'.

  WARNING src/api.ts:47:9 eslint/no-unused-vars
    'headers' is assigned a value but never used.

  hidden: 6 existing diagnostics outside touched ranges
```

If nothing relevant happened, say nothing. Silence is a feature.

If formatting changed the file but produced no relevant diagnostics:

```text
pi-code-feedback: formatted src/api.ts with biome.
```

If the LSP is unavailable or slow, do not block the agent loop for long. Cache delayed results and optionally inject them before the next model request if they become relevant.

## LSP tool

Register exactly one agent tool named `lsp`.

Actions:

- `status`
- `diagnostics`
- `hover`
- `definition`
- `references`
- `implementation`
- `type_definition`
- `symbols`
- `workspace_symbols`
- `code_actions`
- `rename`
- `capabilities`
- `reload`
- `request`

Parameters:

```ts
type LspToolParams = {
  action: LspAction;
  path?: string;
  line?: number;       // 1-based for agent ergonomics
  character?: number;  // 1-based for agent ergonomics
  query?: string;
  newName?: string;
  apply?: boolean;
  all?: boolean;
  raw?: boolean;
  request?: string;
  params?: unknown;
};
```

Guidance:

- `diagnostics` defaults to touched/relevant diagnostics for the current session when possible.
- `diagnostics all:true` returns raw file/project diagnostics, bounded and truncated.
- Navigation actions require `path`, `line`, and `character` unless the action naturally uses `query`.
- `request` is an escape hatch for debugging and should be marked advanced in the description.
- Formatting is intentionally absent from this tool.

## Human command

Register one human command named `lsp`. Commands and tools live in separate pi namespaces, so the human `/lsp ...` command can coexist with the agent-facing `lsp({...})` tool.

Subcommands:

- `/lsp status` — active language servers, known roots, last diagnostics, formatter availability.
- `/lsp enable` — enable LSP feedback for the current session.
- `/lsp disable` — disable LSP feedback for the current session.
- `/lsp restart` — restart LSP clients and reload LSP config.
- `/lsp diagnostics [path|all]` — inspect diagnostics without provenance filtering.
- `/lsp capabilities [path]` — inspect server capabilities.

Formatting stays out of `/lsp`. If we need a human formatter command, it should be named for formatting, not hidden under LSP.

## Event pipeline

### session_start

1. Resolve the project root.
2. Load project and user config.
3. Detect available language servers and formatters.
4. Initialize runtime state.
5. Set a compact status item if the pi UI supports it.

### tool_call

For `write`, `edit`, and `apply_patch`:

1. Resolve the file path.
2. Skip vendor/generated/binary files.
3. Read the before-content if the file exists.
4. Store a pending edit record keyed by tool call id when possible, otherwise by path plus turn/write index.

For `apply_patch`, capture one pending edit record per operation. For moves, read before-content from the source path and track final ranges against the destination path. For deletes, record the deletion so LSP state can be invalidated, but do not invent final-line diagnostics for a file that no longer exists.

For `read` optionally:

1. Warm the relevant LSP client in the background.
2. Do not emit feedback.

### tool_result

For successful `write`, `edit`, and `apply_patch`:

1. Resolve the pending edit record.
2. Read after-agent-content.
3. Compute changed ranges in after-agent-content.
4. Take or retrieve a pre-edit diagnostic snapshot.
5. Run the selected formatter if auto-format is enabled.
6. If formatter changed the file, map changed ranges into final-content.
7. Sync final-content to the LSP.
8. Wait briefly for fresh diagnostics.
9. Filter diagnostics by edit provenance.
10. Append a compact feedback block if useful.

### context

If delayed diagnostics arrive after the tool result timeout, inject a short message before the next model call only when they are still linked to the latest touched ranges.

### agent_end

Flush any deferred formatting/diagnostic work. This mode is for expensive formatters or projects where immediate formatting causes too much churn.

### session_shutdown

Stop all LSP subprocesses and clear timers.

## Diagnostic provenance filter

The filter decides which LSP diagnostics deserve inline feedback.

Inputs:

- before-content
- after-agent-content
- final-content after formatting/autofix
- changed ranges in after-agent-content
- changed ranges mapped to final-content
- pre-edit diagnostic snapshot
- post-edit diagnostic snapshot
- LSP `relatedInformation`
- document symbols or tree-sitter ranges if available

Default policy:

> If we cannot prove a diagnostic is linked to the edit, do not inline it.

### Link reasons

Show a diagnostic inline if any of these are true:

1. `overlap`: diagnostic range intersects the touched final ranges.
2. `expanded-symbol`: diagnostic intersects the enclosing function/class/block of a touched range.
3. `related-information`: diagnostic is elsewhere, but one of its related locations intersects a touched range.
4. `new-on-touched-file`: diagnostic is new or worsened, and it is in the touched file near the changed range.
5. `cascade-related`: diagnostic is in another file, is new/worsened, and has related information pointing into the touched ranges.

### Hidden diagnostics

Count but do not inline:

- existing diagnostics outside touched ranges
- unrelated diagnostics in other files
- diagnostics from stale LSP versions
- formatter-only style warnings unless the formatter failed to apply

### Changed range computation

Use text diffs to compute changed ranges in the post-edit file.

For `write`, the changed range is the whole file unless an old file existed and a diff narrows it.

For `edit`, prefer tool-result diff details if pi exposes them; otherwise diff before-content and after-agent-content.

For `apply_patch`, prefer per-operation result diffs from the `apply_patch` tool. These can produce multiple touched file/range records from one tool call. Creates default to the whole created file; deletes default to a deletion record with no final touched range.

After formatting, compute a second diff from after-agent-content to final-content and map the original touched ranges through it. If mapping is uncertain, expand rather than shrink. False positives are better than hiding a directly caused error, but only inside the touched file/symbol.

### Freshness and stale diagnostics

Each LSP text document has a monotonically increasing local version. For every sync:

- increment the version
- send `didOpen` or `didChange`
- optionally send `didSave`
- record `minimumDiagnosticVersion`
- ignore diagnostics older than that version
- timeout quickly and report delayed diagnostics later

If a server does not include versions in published diagnostics, accept diagnostics only after a sync barrier and a short settle window. Mark them as lower confidence internally.

### Diagnostic identity

For pre/post comparison, identity should be stable across small line shifts:

```text
uri | source | code | normalized message | nearest symbol name | relative range bucket
```

Severity worsening means:

- a previously absent diagnostic appears
- warning becomes error
- range moves into touched range after edit
- message/code changes on a touched range

## Formatting policy

Formatter selection is deterministic:

- one formatter per file by default
- nearest project config wins
- never run a formatter just because it exists globally, except canonical ecosystem tools
- always disclose when formatting changed a file

Initial formatter map:

- Go: `gofmt`
- Rust: `rustfmt`
- Zig: `zig fmt`
- JS/TS/JSON/CSS/HTML: Biome if `biome.json*`, else Prettier if configured or project dependency exists
- Python: Ruff if configured, else Black only if configured
- Shell: `shfmt` only if configured or explicitly enabled
- Lua: `stylua` only if configured

The LSP tool does not format. Formatting is automatic pipeline behavior; if a human formatter command is added later, it must not live under `/lsp`.

## Language servers

Initial LSP client support:

- TypeScript/JavaScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`
- Rust: `rust-analyzer`
- Go: `gopls`
- JSON/CSS/HTML: `vscode-json-language-server`, `vscode-css-language-server`, `vscode-html-language-server`
- YAML: `yaml-language-server --stdio`
- Lua: `lua-language-server`

Servers start lazily per root and shut down after an idle timeout. A single project may have multiple roots if language config demands it.

## Configuration

Project config file: `.pi-code-feedback.json`.

User config file: `~/.config/pi-code-feedback/config.json`.

Project config wins over user config for project behavior. CLI flags win over both.

Suggested shape:

```json
{
  "enabled": true,
  "strict": false,
  "autoFormat": true,
  "formatMode": "immediate",
  "diagnostics": {
    "inline": "touched",
    "maxInline": 8,
    "settleMs": 700,
    "timeoutMs": 1800,
    "delayedTimeoutMs": 8000,
    "expandToSymbol": true,
    "includeCrossFileRelated": true
  },
  "lsp": {
    "enabled": true,
    "idleTimeoutMs": 240000,
    "servers": {}
  },
  "formatters": {}
}
```

Flags:

- `--no-code-feedback`
- `--code-feedback-no-lsp`
- `--code-feedback-no-format`
- `--code-feedback-strict`
- `--code-feedback-all-diagnostics`

## Module layout

Target package layout:

```text
pi-code-feedback/
  package.json
  tsconfig.json
  index.ts
  src/
    config.ts
    types.ts
    runtime.ts
    render.ts
    paths.ts
    fs.ts
    events/
      tool-call.ts
      tool-result.ts
      context.ts
      session.ts
    lsp/
      tool.ts
      service.ts
      client.ts
      protocol.ts
      servers.ts
      positions.ts
    diagnostics/
      snapshots.ts
      provenance.ts
      ranges.ts
      identity.ts
      symbols.ts
    format/
      service.ts
      formatters.ts
      mapping.ts
    commands/
      status.ts
      diagnostics.ts
      format.ts
```

Keep the implementation direct. Avoid a plugin architecture until a real local need appears.

## Internal data model

Important concepts:

```ts
type TouchedRange = {
  uri: string;
  startLine: number;
  endLine: number;
  source: "tool-diff" | "content-diff" | "whole-file" | "formatter-map";
  confidence: "exact" | "expanded" | "approximate";
};

type PendingEdit = {
  id: string;
  toolName: "write" | "edit" | "apply_patch";
  filePath: string;
  beforeContent: string | undefined;
  beforeDiagnostics: DiagnosticSnapshot | undefined;
  turnIndex: number;
  writeIndex: number;
  startedAt: number;
  applyPatchOperationIndex?: number;
  originalPath?: string;
};

type LinkedDiagnostic = {
  diagnostic: LspDiagnostic;
  linkReason: DiagnosticLinkReason;
  touchedRange?: TouchedRange;
  isNewOrWorsened: boolean;
};
```

## Rendering rules

- Prefer file paths relative to project root.
- Use 1-based line and character positions in all agent-visible text.
- Cap inline diagnostics by severity and relevance.
- Show errors before warnings.
- Include source/code when available.
- Include hidden counts.
- Include command/tool hint only when useful:

```text
Use lsp({action:"diagnostics", path:"src/api.ts", all:true}) for full file diagnostics.
```

## Build order

This is the construction order, not an MVP boundary:

1. Wire config, runtime state, commands, and no-op-safe extension loading. ✅
2. Implement path filtering and pending edit capture. ✅
3. Implement changed-range calculation and diagnostic provenance filtering. ✅
4. Implement LSP process/client service with versioned diagnostics. ✅
5. Implement `lsp` tool actions and rendering, including safe text-edit application for `rename` and selected `code_actions apply:true`. ✅
6. Implement provenance filtering and inline feedback. ✅
7. Implement formatter service and automatic formatting. ✅
8. Add delayed context injection and status UI. ✅
9. Add tests with fake LSP servers and golden diagnostic-filter cases.

At every step, the code should follow the final module boundaries above rather than temporary throwaway structure.

## Tests

Use fixture-driven tests rather than broad mocks.

Critical cases:

- Diagnostic directly overlaps edited line.
- Diagnostic moves after formatter changes line numbers.
- Diagnostic is elsewhere but has relatedInformation into touched line.
- Existing unrelated project diagnostic is hidden.
- Cross-file diagnostic without relatedInformation is hidden.
- Cross-file diagnostic with relatedInformation is shown.
- LSP publishes stale diagnostics after a newer sync; stale diagnostics are ignored.
- Formatter changes file and LSP diagnostics are based on final content.
- Slow LSP result is deferred and then injected once.

## Open questions

- Should strict mode block only errors, or warnings with selected sources too?
- `lsp({action:"rename", apply:true})` and selected `code_actions apply:true` may mutate files directly, but only safe text edits inside the project root. Resource operations and ambiguous code-action selection are rejected.
- How much tree-sitter should we vendor/use before relying on LSP document symbols?
- Should project-wide diagnostics ever be auto-run, or only on explicit `lsp diagnostics all:true`?

