# pi-prompt-suggestion

English | [中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that predicts your next message after each turn and shows it as dimmed ghost text in the empty input box.

- **Tab** accepts the suggestion; **Esc** dismisses it.
- Typing hides it; clearing the input box brings it back. Sending a message or starting a new turn discards it.
- **Tab** in an empty input box with no suggestion generates one immediately.

Suggestions start after the second assistant reply, once the input box has been idle for the configured delay (20s by default).

## Highlights

- **Predicts what you would say, not what the assistant would.** The prompt and output rules follow Claude Code's prompt-suggestion feature: a suggestion is the next thing you would type yourself, not an assistant-voice offer.
- **Silent rather than wrong.** Model output goes through a deterministic filter that rejects evaluations ("looks good", "thanks"), assistant-voice text, Markdown, code, multiple sentences, and anything too long. When there is no good guess, nothing is shown.
- **Reuses the session's prompt cache.** In fork mode the request is identical to the main loop's (same thinking level, tools, and parameters), so it hits the session's own cache: 99.9% cache hits measured on a long session, so even a full-context request costs little more than cache reads. Once the cache turns cold, expires, or keeps missing, fork is turned off for the rest of the session and the cheap segment mode is used instead, optionally with a cheaper segment model.
- **Speaks your language.** Chinese conversations get Chinese suggestions; the filter also catches CJK pleasantries and assistant voice.
- **Plays well with other editor extensions.** It wraps the current input editor instead of replacing it, so it works alongside extensions that install their own editor (such as `pi-powerline-footer`). If it can't draw inside the editor, it shows a line above it instead.
- **Works out of the box.** Uses the session's model by default with no setup; every setting is in `/suggestion` and applies immediately.
- **Lightweight.** A single file with no dependencies beyond pi itself.

## Install

The extension is published to npm. Install it with pi's package manager:

```bash
pi install npm:pi-prompt-suggestion
```

This adds it to `packages` in `~/.pi/agent/settings.json`, so it loads in every session. Restart pi (or run `/reload`) to activate it.

```bash
pi install -l npm:pi-prompt-suggestion  # this project only (.pi/settings.json)
pi -e npm:pi-prompt-suggestion          # try it for one session without installing
pi update npm:pi-prompt-suggestion      # update to the latest version
pi remove npm:pi-prompt-suggestion      # uninstall
```

## Usage

Just keep working. After a turn ends and the input box stays empty for the idle delay, the predicted message appears as dimmed text:

| Key | Action |
|---|---|
| Tab | Accept: puts the text in the input box (press Enter to send, or edit it first) |
| Tab (empty box, nothing shown) | Generate a suggestion now |
| Esc | Dismiss |
| Any other key | Type normally; the suggestion comes back if you clear the box |

## How it generates

Pick the mode with `/suggestion` → Context mode:

- **segment** (default): sends a short excerpt of the last turn to the **segment model**. Cheap and fast. The segment model follows the session's model unless you pick another one (for example a cheaper model) under Segment model.
- **fork**: replays the full session with the **session's model**, so the request reuses the session's own prompt cache, which gives the best suggestions at low cost when the cache is warm. Fork falls back to segment (using the segment model) when the model doesn't return a usable answer. Once the cache looks cold or expired, or forks keep missing the cache, fork is turned off for the rest of the session and segment is used instead; a new session or `/reload` turns it back on.

## Settings

Run `/suggestion` to open the settings screen. Settings are stored in `~/.pi/agent/prompt-suggestion.json` (or under `PI_CODING_AGENT_DIR`) and take effect immediately.

| Setting | Default | Description |
|---|---|---|
| Enabled | on | When off, no requests are sent |
| Context mode | segment | `fork` (session model, reuses the prompt cache) or `segment` (segment model, short excerpt) |
| Segment model | Follow session | Model for segment requests, including fork's fallback; fork always uses the session model |
| Tab to generate | on | Tab in an empty input box generates immediately |
| Idle delay | 20s | How long the input box must stay idle after a turn |
| Max length | 30 chars | Longer suggestions are discarded |
| Cache freshness | 300s | Older replies are treated as an expired cache (fork is turned off for the session) |
| Fork context limit | unlimited | Skip fork above this many tokens |
| Diagnostic log | off | Write one JSONL line per generation to `~/.pi/agent/prompt-suggestion.log` |

`PI_SUGGESTION_LOG=<path>` also enables the diagnostic log.

## Cost

Each suggestion is one extra model request. In segment mode it is a small request; in fork mode it is a full-context request that is mostly cache reads when the cache is warm. Turn it off with `/suggestion` → Enabled → off.

## License

MIT
