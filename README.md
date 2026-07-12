The extensions I use in `pi` (https://pi.dev/).

You really shouldn't install them from here.
Running agents with unmitigated access to your machine and network is already insane enough as is;
there's no need to also add random code giving them random abilities.
`pi`'s greatest power is how easily extensible it is by the agent itself. Just ask your own agent to
reimplement any extension you like, and for the love of God, read the code to ensure it is not contacting some Iranian server or extracting private keys, even if you do not know TS.

Every top-level extension is a directory with an `index.ts` entry point:

| Extension | Purpose |
| --- | --- |
| `codex` | OpenAI Codex model routing and quota reporting |
| `code-feedback` | LSP diagnostics and automatic formatter feedback |
| `helpers` | Runtime profiling and small TUI fixes |
| `latex-unicode` | LaTeX-to-Unicode message rendering |
| `wolfram-sessions` | Session-scoped Wolfram/Mathematica kernels |
| `rich-tools` | Rich tool rendering, web tools, patching, and image support |
| `system-context` | Linux system context injected into the model prompt |
| `wayland-surface` | Wayland surface sharing and screenshots |
| `workflows` | Deterministic multi-agent workflows |
