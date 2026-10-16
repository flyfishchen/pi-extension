# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Extensions for the [pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Each extension lives in its own folder with an `index.ts` entry point; pi loads TypeScript directly through jiti, so there is no build step. Extensions may only import pi's own packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`) and Node built-ins unless the folder gets its own `package.json`.

Extensions are loaded from this folder, not copied: each one is listed by path in the `extensions` array of `~/.pi/agent/settings.json` (e.g. `"~/project/pi-extension/prompt-suggestion"`). Adding a new extension means adding its folder there. After editing code, run `/reload` inside pi.

pi reference material is in the global install: `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` (`extensions.md`, `settings.md`, `packages.md`) and the exact API types in `dist/core/extensions/types.d.ts`. pi-tui components are in `node_modules/@earendil-works/pi-tui/dist/components/`.

## Running and testing

There is no test framework. Use these instead:

```bash
# Load only one extension (no other extensions, no MCP, no saved session)
pi -ne --no-mcp -e ./prompt-suggestion --no-session --model newapi/deepseek-flash

# Replay a real session through prompt-suggestion's request pipeline (sends real requests)
node prompt-suggestion/scripts/replay.mjs ~/.pi/agent/sessions/<dir>/<file>.jsonl --model newapi/deepseek-flash --cuts 3
node prompt-suggestion/scripts/replay.mjs <file> --model newapi/deepseek-flash --mode segment --cuts 1
node prompt-suggestion/scripts/replay.mjs <file> --model newapi/deepseek-flash --thinking high --last   # mirror a session at thinking=high
node prompt-suggestion/scripts/replay.mjs <file> --model newapi/deepseek-flash --dry                     # build requests only
```

`replay.mjs` builds requests with the extension's exported builders (`buildForkRequest`, `buildSegmentRequest`) and sends them the same way (fork via `completeSimple`, segment via `complete`). It prints per cut point: total input, `cacheRead`/`cacheHit`, output tokens, whether the output parsed, the suggestions, and what the user actually typed next; `--raw` also prints the raw model output. Models come from `~/.pi/agent/models.json` (custom providers such as `newapi`).

TUI behavior is tested by driving real pi in tmux: `tmux new-session -d -s t -x 120 -y 40 "pi ..."`, then `tmux send-keys -t t -l "text"` / `tmux send-keys -t t Tab`, and `tmux capture-pane -t t -p` (add `-e` to see colors, e.g. that ghost text is dimmed). Note that the user's normal setup includes `pi-powerline-footer`, which replaces the input editor; test with it loaded (plain `pi`) as well as with `-ne`.

## prompt-suggestion

Predicts the user's next message after a turn and shows it as dimmed ghost text in the empty input box. Modeled on Claude Code's prompt-suggestion feature (prompt, deterministic output filter, cache gating).

**Flow.** `agent_settled` → idle delay → `runSuggestion` → `generateCards` → show the first candidate that passes the filter. Tab in an empty editor with no suggestion triggers generation immediately (`triggerNow`).

**Two request shapes** (`generateCards`):
- `fork`: replays the full session (`buildSessionProjection` → `convertToLlm`) and appends one user message (`buildForkInstruction`). This is only worthwhile if it hits the session's own prompt cache, so `buildForkRequest` must keep the request identical to the main loop's. Measured on DeepSeek: a different thinking level, `tool_choice`, or `response_format` each break cache sharing (thinking off / `tool_choice:"none"` also make DeepSeek drop all past `reasoning_content`, ~40% of a long session). Therefore: send via `modelRegistry.streamSimple` with `reasoning: pi.getThinkingLevel()`, no tool restrictions, no JSON mode, no `maxTokens` (the main loop sends none; a cap makes pi shrink the thinking budget, changing the thinking parameters), and never pass `systemPrompt` when the projection already starts with a system message (pi would prepend a second one). "No tools / JSON only" is enforced by the instruction text alone; a `toolUse` stop or unparseable output falls back to segment. Fork is skipped when a different model is configured, the cache looks cold (`forkSkipReason`), or two forks in a row get zero cache hits.
- `segment`: a short excerpt (`lastTurnSegment`) with `buildInstruction` as the system prompt. Cheap; used as the fallback.

**Output handling.** The model returns `{"suggestions": [...]}` (fork) or a JSON array (segment). `parseOutput` never falls back to splitting free text into lines (that once turned Markdown headings into suggestions). `rejectReason` is the deterministic filter; its CJK regexes are intentional (they catch Chinese/Japanese/Korean pleasantries and assistant voice). Prompts are in English, so both carry an explicit language rule next to the output format ("if the user writes Chinese, write Chinese"); without it, segment mode answered Chinese conversations in English about 40% of the time. Follow-up questions are allowed (no `?` filter).

**Ghost text in the editor.** The editor component is wrapped rather than replaced, so it layers on top of other extensions that install their own editor:
- `hookEditorInstalls` patches `ctx.ui.setEditorComponent` (one object shared by all extensions) so every editor anyone installs later is wrapped. pi-powerline-footer reinstalls its editor at session start and on the first keypress after a start or `/reload`.
- `patchGhost` wraps the instance's `render`/`handleInput`; `injectGhost` draws after pi-tui's fake-cursor end marker (`\x1b_pi:/fc\x07`) in the rendered line. If that can't be found, a line above the editor is used instead (`scheduleInlineCheck` / `syncGhostLine`).
- Key semantics: Tab accepts (only while visible), Esc dismisses (only while visible), other keys pass through and merely hide the suggestion until the box is empty again; submitting or a new turn discards it.

**Config.** `<pi agent dir>/prompt-suggestion.json` (`getAgentDir()`, so `PI_CODING_AGENT_DIR` and Windows paths work; a UTF-8 BOM is stripped). Read on every use, so edits apply without `/reload`. Edited through the `/suggestion` settings screen (`SETTINGS` array; choosing a "(default)" option deletes the key). `debugLog: true` or `PI_SUGGESTION_LOG=<path>` writes one JSONL line per generation (path taken, skip reason, usage) to `prompt-suggestion.log`.

All user-facing text and code comments are in English.

Older versions of the extension (before it moved here) are in `~/.pi/agent/backups/prompt-suggestion/`.
