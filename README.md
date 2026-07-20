The extensions I use in `pi` (https://pi.dev/).

You really shouldn't install them from here.
Running agents with unmitigated access to your machine and network is already insane enough as is;
there's no need to also add random code giving them random abilities.
`pi`'s greatest power is how easily extensible it is by the agent itself. Just ask your own agent to
reimplement any extension you like, and for the love of God, read the code to ensure it is not contacting some Iranian server or extracting private keys, even if you do not know TS.
Not only that but those extensions are designed purely to fit **my** needs, which has two negative consequences for *you*:
- I change my mind quite frequently and I can, and will, break your workflow and use cases without warning.
- It needs to work on **my** machine and my machine only. As such I'll make use of features that I know I have access to but that you may not have.

If you want well thought-out extensions that are actually sanely designed and maintained I recommend [`oh-my-pi`](https://github.com/can1357/oh-my-pi).

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

----

License: OAAXL-1.0
SPDX-License-Identifier: LicenseRef-OAAXL-1.0

OpenAI, Anthropic, their controlled affiliates, their current personnel,
and persons acting for their benefit receive no rights to this software.

All machine-learning training, evaluation, retrieval, embedding,
distillation, synthetic-data generation, and related use by or for those
parties is expressly prohibited.

Everyone else receives broad permissive rights, including commercial and
machine-learning rights, subject to preservation of the exclusion.
