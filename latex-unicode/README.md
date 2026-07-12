# latex-unicode

The default `render` mode converts LaTeX only while TUI Markdown is rendered.
Original messages, session files, and model context remain unchanged.

Configure the extension in `$PI_CODING_AGENT_DIR/latex-unicode.json`, which is
`~/.pi/agent/latex-unicode.json` by default:

```json
{
  "mode": "render"
}
```

Set `mode` to `rewrite` to convert loaded and future user/assistant messages,
including the context sent to the model. Existing session JSONL lines remain
append-only and are converted in memory whenever the session is loaded.

For a one-process override, use `--latex-unicode-mode render` or
`--latex-unicode-mode rewrite`.
