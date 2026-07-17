# code-feedback

`code-feedback` is a Pi extension that closes the loop after source edits: it tracks the lines an
agent changed, runs one deterministic formatter when a canonical or project-configured candidate
is available, refreshes real language-server diagnostics, and adds only relevant feedback to the
tool result.

It also exposes a strict `lsp` tool for navigation, consistency-labeled diagnostics, symbols, code
actions, preview-first symbol renames, and transactional file renames. The human-facing control
surface is the `/lsp` command and a compact footer status.

## What it registers

- the agent-facing `lsp` tool
- the human-facing `/lsp` command
- CLI flags for disabling or tightening parts of the feedback loop
- a footer item showing active LSP clients and recent diagnostic latency
- hooks around successful `write`, `edit`, `apply_patch`, applied LSP WorkspaceEdits, and `bash`
  results

Formatting is deliberately **not** an LSP tool method. It runs automatically after a tracked
mutation and before diagnostics.

## Setup

The directory is a normal Pi extension package: `index.ts` is the entry point and no build step is
required. In an auto-discovered location such as `~/.pi/agent/extensions/code-feedback`:

```bash
npm install
```

Then start Pi or run `/reload`. Language-server and formatter executables must be available from a
selected Python environment, the target project's `node_modules/.bin`, or Pi's inherited `PATH`.
Use `/lsp status` to see missing commands and the routes that have actually started.

## Automatic feedback pipeline

For each successful tracked mutation, code-feedback:

1. captures the old content and any already-known diagnostic snapshot before the tool runs;
2. computes touched ranges from the tool diff when possible, otherwise from the content change;
3. runs one selected formatter if the tool changed the file;
4. remaps touched ranges through any formatter rewrite;
5. announces the complete mutation batch to already-running language servers;
6. refreshes diagnostics after the final content is on disk;
7. links diagnostics to the edit and appends useful feedback to the original tool result.

The default diagnostic view is intentionally narrow. It includes diagnostics that overlap or are
near touched lines, diagnostics linked through LSP `relatedInformation`, and newly worsened
cross-file diagnostics with an authoritative related-information link. Up to eight linked findings
are shown.

Post-edit diagnostics that appear or worsen on other files without an attribution link are shown
separately as **possible workspace impact (not attributed)**. They are useful project signals, but
they never make strict mode fail an edit.

The normal inline diagnostic budget is 500 ms. If a server is slower, code-feedback keeps waiting
in the background for up to 8 seconds and can prepend stale-checked feedback before the next model
request. Delayed feedback is tied to mutation generations and hashes of every displayed file, so a
later tracked edit or external content change invalidates it. `/lsp context off` disables only this
injection channel and preserves already queued feedback.

When feedback is attached, structured data is mirrored under:

```text
result.details.piCodeFeedback
```

It contains touched ranges, range provenance, per-phase timing, formatter status, linked
diagnostics, and possible workspace impact for each edit.

### Strict mode

`--code-feedback-strict` extends the inline wait to 1.8 seconds and marks the mutation tool result
as an error when a linked diagnostic has error severity. Unattributed workspace impact remains
non-failing. Strict mode does not turn timeouts or unavailable servers into clean results.

## The `lsp` tool

The tool accepts a closed LSP-lite method set; arbitrary protocol requests and legacy aliases are
not supported.

| Method | Required arguments | Behavior |
| --- | --- | --- |
| `server/status` | — | Show configuration, clients, resource use, formatter availability, and recent failures. |
| `server/capabilities` | — | Show known clients; add `path` to start matching clients and inspect their advertised capabilities. |
| `server/reload` | — | Restart clients and clear startup cooldowns. It does not reread JSON configuration; use Pi's `/reload` for that. |
| `textDocument/diagnostic` | `path` | Refresh one file; report authoritative pull or eventually consistent push state. |
| `workspace/diagnostic` | `path` | Run a bounded active scan; optional `limit` defaults to 50 and is capped at 200. |
| `textDocument/hover` | `path`, position | Return the first non-empty hover from matching language routes. |
| `textDocument/definition` | `path`, position | Return merged definitions. |
| `textDocument/references` | `path`, position | Return merged references, including declarations. |
| `textDocument/implementation` | `path`, position | Return merged implementations. |
| `textDocument/typeDefinition` | `path`, position | Return merged type definitions. |
| `textDocument/documentSymbol` | `path` | Return merged document symbols. |
| `workspace/symbol` | `query` | Search existing clients; add `path` to select and lazily start matching clients. |
| `textDocument/codeAction` | `path`, position | Return code actions with session-local preview ids for safely applyable edits. |
| `textDocument/rename` | `path`, position, `newName` | Preview a symbol-rename WorkspaceEdit. |
| `workspace/renameFile` | `path`, `newPath` | Preview import/reference edits from `workspace/willRenameFiles`; never moves during preview. |
| `workspaceEdit/apply` | `id` | Apply one previously previewed edit or file-rename transaction. |

Every method also accepts an optional `server` id. Automatic diagnostics and code actions use both
`language` and `linter` routes. Semantic methods use only `language` routes unless `server` is
explicitly supplied. Methods that need one authoritative client, such as rename, require `server`
when multiple language routes match.

Set `raw: true` only for protocol debugging. For code actions and renames, raw mode is
inspection-only and does not create an apply id.

### Positions

Position-scoped methods use positive 1-based coordinates. A direct `column` is a 1-based LSP
UTF-16 code-unit column:

```text
line=12 column=8
```

Alternatively, pass an exact case-sensitive symbol on that line:

```text
line=12 symbol="renderStatus" occurrence=2
```

`column` and `symbol` are mutually exclusive. `occurrence` is 1-based, defaults to 1, and is valid
only with `symbol`. Identifier-like symbols require identifier boundaries. Symbol resolution is
Unicode-aware and converts the match to the UTF-16 offset required by LSP, making it the safer form
on Unicode-heavy lines.

### Diagnostic consistency

Explicit diagnostic methods have a separate 10-second budget and report the consistency model they
actually obtained:

- Pull-capable servers return authoritative fresh diagnostics. Timeout or unavailability is an
  error with no diagnostics.
- Push-only servers have no request completion response. After a bounded observation window,
  `textDocument/diagnostic` returns the server's persistent published state as eventually
  consistent instead of misreporting an intentionally suppressed duplicate publication as a
  timeout.
- `workspace/diagnostic` uses one absolute deadline for the whole scan. It distinguishes fresh,
  eventually consistent, timed-out, unavailable, and skipped files; only an all-fresh scan is
  authoritative. When several servers cover one file, the aggregate file outcome and the returned
  diagnostic-state consistency are reported separately, so an unavailable route cannot hide
  eventually consistent diagnostics contributed by another route.

The scan chooses the strongest protocol each server advertises. It first attempts one real
`workspace/diagnostic` pull per routed workspace. Missing, malformed, oversized, or immediately
unsupported workspace reports use bounded `textDocument/diagnostic` pulls when available. A
push-only server receives one bulk document synchronization. New publications are fresh; files for
which the server suppresses an unchanged publication retain their latest published state and are
reported as eventually consistent. Scan-only documents are closed again. No fallback starts after
the shared deadline, and a genuinely timed-out push batch stops its client so non-cancellable
background work cannot continue consuming resources.

`typescript-language-server` advertises only push diagnostics, but exposes fixed synchronous
tsserver diagnostic commands. Code-feedback uses those commands as authoritative document pulls.
This avoids a server behavior that suppresses repeated clean `publishDiagnostics` notifications,
which otherwise makes an unchanged error-free file look as though diagnostics never completed.

Push diagnostic state is persistent until the server replaces it. Code-feedback therefore keeps a
valid previous publication instead of invalidating it before a refresh. A push-batched file is
fresh only after a valid post-synchronization publication and a short diagnostic quiet period;
silence is labeled eventually consistent, while malformed publications remain unavailable and are
never interpreted as clean.

Workspace traversal stays inside the trusted project root, never follows symlinks, stops after
50,000 entries and 8 MiB of selected source, and ignores common VCS, dependency,
virtual-environment, cache, coverage, and build directories.

Examples:

```text
lsp method="textDocument/diagnostic" path="src/index.ts"
lsp method="workspace/diagnostic" path="src" limit=100 server="typescript"
lsp method="textDocument/definition" path="src/index.ts" line=42 symbol="createRuntime"
lsp method="workspace/symbol" path="src/index.ts" query="WorkspaceEdit"
```

### Preview and apply

Code actions and symbol renames return ids such as `we_0001`. Applying an id is a separate tool
call:

```text
lsp method="textDocument/rename" path="src/old.ts" line=8 symbol="oldName" newName="newName"
lsp method="workspaceEdit/apply" id="we_0001"
```

Preview ids are bounded, session-local, and one-shot. Apply revalidates the project root, file
contents and permissions, target set, document versions, and source server session. Only regular
files inside the project are accepted. Server resource operations and command-only code actions
are not executed.

Multi-file text edits acquire Pi's shared mutation queues in canonical order, stage all output,
replace files atomically, and roll back already committed files after a partial failure. Duplicate
byte-identical replacement edits are coalesced; unsafe overlaps are rejected. Successful applies
then go through the same formatter and diagnostic feedback pipeline as built-in edit tools.

File rename is an explicit extension operation around `workspace/willRenameFiles`:

```text
lsp method="workspace/renameFile" path="src/old.ts" newPath="src/new.ts"
lsp method="workspaceEdit/apply" id="we_0002"
```

Preview never moves the file. Apply commits server text edits first, reserves the destination
without overwriting it, moves the source last, and rolls back text edits if the move fails. The
source must be a regular in-project file; the destination must be absent, inside the project, and
have an existing parent directory. Directories, symlink sources, existing destinations,
cross-filesystem moves, stale server sessions, unsupported servers, and server resource operations
are rejected.

## Human `/lsp` command

| Command | Purpose |
| --- | --- |
| `/lsp` or `/lsp status` | Full session status, client roots/roles, resource counters, server config, and formatter commands. |
| `/lsp capabilities [path]` | Inspect known or selected server capabilities. |
| `/lsp diagnostics [path\|all]` | Deliberately inspect cached session diagnostics and recent touched ranges; this command does not promise freshness. |
| `/lsp enable` | Enable LSP feedback for the session when the extension itself is enabled. |
| `/lsp disable` | Disable LSP feedback and shut down all clients. Formatting remains controlled separately. |
| `/lsp restart` | Restart clients on demand. |
| `/lsp context [status\|on\|off\|toggle]` | Control delayed model-context injection without disabling diagnostics or formatting. |
| `/lsp trust [status\|add <path>\|remove <path>\|clear]` | Manage session-persisted external environment/workspace roots. `/lsp trust <path>` is shorthand for `add`. |
| `/lsp help` | Show command usage. |

## CLI flags and defaults

| Flag | Effect |
| --- | --- |
| `--no-code-feedback` | Disable all automatic code feedback for the session. |
| `--code-feedback-no-lsp` | Disable LSP clients and LSP diagnostics; automatic formatting may still run. |
| `--code-feedback-no-format` | Disable the automatic formatter pass. |
| `--code-feedback-no-context` | Disable delayed diagnostic injection while keeping LSP and formatting active. |
| `--code-feedback-strict` | Wait longer and fail mutation results on linked error diagnostics. |
| `--code-feedback-all-diagnostics` | Inline all diagnostics in the post-edit snapshot instead of touched/provenance-linked diagnostics. |
| `--code-feedback-lsp-concurrency=<1-16>` | Concurrent document-pull and ordinary diagnostic refreshes; default 4. Push-only workspace scans synchronize as one batch. Same-file refreshes remain ordered/coalesced. |
| `--code-feedback-lsp-max-clients=<1-32>` | Simultaneously active client processes; default 8. |
| `--code-feedback-lsp-start-concurrency=<1-8>` | Simultaneous client initializations; default 2. |

Numeric values are clamped to their documented range. Clients are lazy, expire independently after
four idle minutes, and are evicted least-recently-used when the active budget is full. Busy,
initializing, and diagnostic-active clients are not eviction candidates.

## Built-in language-server routes

Missing binaries do not prevent the extension from loading; the route is reported unavailable when
selected.

| Id | Role | Extensions | Command | Root markers |
| --- | --- | --- | --- | --- |
| `typescript` | language | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | `typescript-language-server --stdio` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `python` | language | `.py`, `.pyi` | `ty server` | `pyproject.toml`, uv/Poetry/Pipenv/setup/requirements markers |
| `python-ruff` | linter | `.py`, `.pyi` | `ruff server` | same Python markers |
| `rust` | language | `.rs` | `rust-analyzer` | `Cargo.toml` |
| `go` | language | `.go` | `gopls` | `go.work`, `go.mod` |
| `haskell` | language | `.hs`, `.lhs`, `.hs-boot`, `.cabal` | `haskell-language-server-wrapper --lsp` | HLS/Cabal/Stack/package markers |
| `clangd` | language | C and C++ source/header extensions | `clangd` | `.clangd`, compilation database/flags, CMake, Meson |
| `json` | language | `.json`, `.jsonc` | `vscode-json-language-server --stdio` | `package.json` |
| `css` | language | `.css`, `.scss`, `.sass`, `.less` | `vscode-css-language-server --stdio` | `package.json` |
| `html` | language | `.html`, `.htm` | `vscode-html-language-server --stdio` | `package.json` |
| `yaml` | language | `.yaml`, `.yml` | `yaml-language-server --stdio` | project/trusted boundary |
| `lua` | language | `.lua` | `lua-language-server` | `.luarc.json`, `.luarc.jsonc` |

Root selection is per file and per route. The nearest matching marker inside the project or trusted
external-root boundary becomes that client's workspace, so one server id may own independent lazy
clients for multiple packages in a monorepo.

The built-in Haskell workspace configuration enables HLint diagnostics and code actions through
HLS.

## Language-server configuration

Strict JSON configuration can add routes, completely replace built-ins, or disable routes:

1. `~/.pi/agent/code-feedback.json` (Pi's configured agent directory in practice)
2. `<project>/.pi/code-feedback.json` (Pi's configured project directory name in practice)

The project file is read only when Pi trusts the project. Project entries replace same-id user
entries. Each source is validated atomically, so a malformed project file does not suppress a valid
user file. Unknown fields are errors. Run `/reload` after changing either file.

```json
{
  "servers": {
    "gleam": {
      "command": ["gleam", "lsp"],
      "extensions": [".gleam"],
      "languageId": "gleam",
      "rootMarkers": ["gleam.toml"],
      "role": "language",
      "env": {
        "LSP_LOG": "warning"
      },
      "initializationOptions": {},
      "workspaceConfiguration": {}
    },
    "python-ruff": {
      "disabled": true
    }
  }
}
```

An enabled entry is a complete route definition:

- `command` is a non-empty argv array.
- `extensions` is a non-empty array of dot-prefixed extensions.
- `languageId` applies to every extension. Optional `languageIds` overrides individual extensions,
  for example `{ ".tsx": "typescriptreact" }`. Without either, the extension minus its dot is used.
- `rootMarkers`, when present, is a non-empty array of exact basenames.
- `role` is `"language"` by default or `"linter"`.
- `env` values must be strings.
- `initializationOptions` accepts arbitrary JSON; `workspaceConfiguration` must be an object.

Defining a built-in id replaces the entire built-in definition; fields are not merged. A disabled
entry may contain only `{ "disabled": true }`. Each config file is capped at 1 MiB.

Relative command paths containing `/` resolve from the project root. Bare commands resolve through
the selected Python environment when applicable, project-local `node_modules/.bin`, then inherited
`PATH`.

This file configures language servers only. There is currently no user-facing formatter override
schema.

## Automatic formatter selection

Exactly one formatter is selected, in the order shown below. A formatter runs only after a real
content change and only when its command exists. A configured higher-priority formatter whose
command is missing does not silently fall through to another style.

| Files | Formatter selection |
| --- | --- |
| Go | `gofmt` |
| Rust | `rustfmt` |
| Zig / ZON | `zig fmt` |
| Haskell `.hs`, `.hs-boot` | Fourmolu with `fourmolu.yaml`, otherwise Ormolu with `.ormolu`, otherwise stylish-haskell with `.stylish-haskell.yaml` |
| C / C++ | `clang-format` with `.clang-format` or `_clang-format` |
| JS/TS, JSON, CSS-family, HTML | Biome with `biome.json`/`biome.jsonc`, otherwise configured Prettier |
| Markdown / MDX / YAML | configured Prettier |
| Python | Ruff format with `ruff.toml`, `.ruff.toml`, or `[tool.ruff…]`; otherwise Black with `[tool.black]` |
| Lua | StyLua with `stylua.toml` or `.stylua.toml` |

Prettier is considered configured by a normal Prettier config file, a `prettier` key in
`package.json`, or a package dependency on Prettier. Literate Haskell and Cabal files are not passed
to the non-literate Haskell formatters. Lockfiles, common generated files, and `.min.js`/`.min.css`
are skipped.

Formatter processes run in place with a 15-second timeout. A successful no-op stays quiet; changes
and process failures are disclosed in feedback, while command availability is visible in
`/lsp status`. Although the formatter service has an internal injectable override used by tests
and benchmarks, the shipped extension exposes no per-formatter command, enable, or disable
configuration. In particular, shell files are not auto-formatted by the default extension.

## Trust and Python environments

Pi project trust gates all project LSP and formatting work. When the project is untrusted, clients
are shut down, project configuration is not read, and the footer reports `lsp: untrusted`.

The inherited process `PATH` is the baseline command trust. `/lsp trust` adds explicit external
roots used for language-environment discovery and as workspace boundaries for files they contain.
These roots are stored as custom entries on the active session branch; they are not global trust
decisions. Automatic edit feedback still tracks project files only.

For Python, code-feedback searches the nearest containing trusted boundary for:

- a `.venv` directory or a `.venv` file pointing to an environment;
- `.venv`, `venv`, or `env` directories while walking upward;
- an active `VIRTUAL_ENV` or `CONDA_PREFIX`, but only when it lies inside a trusted boundary.

The selected environment's `bin` directory is prepended for ty, Ruff, Pyright-like configured
servers, and Python formatters. Ty/Pyright workspace configuration is populated with the selected
interpreter. Environments next to `uv.lock` are labeled as uv environments; conda environments are
recognized by `conda-meta`.

## Filesystem and process integration

- Tracked mutations broadcast `workspace/didChangeWatchedFiles` to already-ready clients without
  starting new ones. Moves additionally send `workspace/didRenameFiles`.
- Multi-file patches and WorkspaceEdits broadcast their complete sibling batch before the first
  diagnostic refresh, so project graph updates see a coherent mutation.
- A successful `bash` result reconciles documents already open in ready clients. It does not scan
  the project or start a server. At most 100 files, 2 MiB per file, and 16 MiB total are inspected.
- Failed shell results are not reconciled because their filesystem state is not authoritative.
- Explicit text-document requests reject source files over 2 MiB and binary content. Tracked
  mutation tools remain successful but skip exact feedback for those files.
- Agent-visible LSP output is capped at 2,000 lines or 50 KiB. Truncated full text is written to a
  temporary file; structured details are separately bounded.
- Stdio writes are serialized under a 16 MiB queue budget. Inbound headers are capped at 8 KiB and
  messages at 16 MiB. A blocked write fails the client after five seconds.
- Deterministic initialization failures cool down for three minutes. Cancellation and
  initialization timeouts remain immediately retryable; restart/reload clears the cooldown.

The deterministic correctness and resource gates are implemented by
`scripts/release-gate.mjs`; real-server probes live in `scripts/real-lsp-smoke.mjs`.

## Development and validation

```bash
npm run typecheck
npm test
npm run check
npm run perf
npm run smoke:lsp
npm run release:check
npm run release:check:live
```
