# pi-prompt-suggestion

A [pi](https://pi.dev) extension that predicts your next message after each turn and shows it as dimmed ghost text in the empty input box.

- **Tab** accepts the suggestion; **Esc** dismisses it.
- Typing hides it; clearing the input box brings it back. Sending a message or starting a new turn discards it.
- **Tab** in an empty input box with no suggestion generates one immediately.

Suggestions start after the second assistant reply, once the input box has been idle for the configured delay (20s by default). Output goes through a deterministic filter that rejects evaluations ("looks good"), assistant-voice text, Markdown, code, multiple sentences, and anything too long, so it stays silent rather than showing a bad guess.

Works alongside extensions that replace the input editor (such as `pi-powerline-footer`).

## Install

```bash
pi install npm:pi-prompt-suggestion
```

Try it for one session without installing:

```bash
pi -e npm:pi-prompt-suggestion
```

## How it generates

- **segment** (default): sends a short excerpt of the last turn. Cheap and fast.
- **fork**: replays the full session so the request reuses the session's own prompt cache, which gives the best suggestions at low cost when the cache is warm. Fork is skipped (falling back to segment) when a different model is configured, the cache looks cold or expired, or forks keep missing the cache.

## Settings

Run `/suggestion` to open the settings screen. Settings are stored in `~/.pi/agent/prompt-suggestion.json` (or under `PI_CODING_AGENT_DIR`) and take effect immediately.

| Setting | Default | Description |
|---|---|---|
| Enabled | on | When off, no requests are sent |
| Tab to generate | on | Tab in an empty input box generates immediately |
| Context mode | segment | `fork` or `segment` (a custom model always uses segment) |
| Model | follow session | Use a different (e.g. cheaper) model for suggestions |
| Idle delay | 20s | How long the input box must stay idle after a turn |
| Max length | 30 chars | Longer suggestions are discarded |
| Cache freshness | 300s | Older replies are treated as a cold cache (fork falls back to segment) |
| Fork context limit | unlimited | Skip fork above this many tokens |
| Diagnostic log | off | Write one JSONL line per generation to `~/.pi/agent/prompt-suggestion.log` |

`PI_SUGGESTION_LOG=<path>` also enables the diagnostic log.

## Cost

Each suggestion is one extra model request. In segment mode it is a small request; in fork mode it is a full-context request that is mostly cache reads when the cache is warm. Turn it off with `/suggestion` → Enabled → off.

## License

MIT
