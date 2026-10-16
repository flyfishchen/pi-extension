# pi-extension

English | [中文](README.zh-CN.md)

Extensions for the [pi coding agent](https://pi.dev). Each extension is published to npm as a pi package, so pi installs it directly.

| Extension | Description | npm |
|---|---|---|
| [prompt-suggestion](prompt-suggestion/) | Predicts your next message after each turn and shows it as ghost text in the input box (Tab to accept) | [`pi-prompt-suggestion`](https://www.npmjs.com/package/pi-prompt-suggestion) |

## Install

Install with pi's package manager (it fetches the package from npm):

```bash
pi install npm:pi-prompt-suggestion
```

This adds `"npm:pi-prompt-suggestion"` to `packages` in `~/.pi/agent/settings.json`, so it loads in every pi session. Restart pi (or run `/reload` in a running session) to activate it.

Other options:

```bash
pi install -l npm:pi-prompt-suggestion     # this project only (.pi/settings.json)
pi install npm:pi-prompt-suggestion@0.1.0  # pin a version
pi -e npm:pi-prompt-suggestion             # try it for one session without installing
```

Manage it:

```bash
pi list                             # show installed packages
pi update --extensions              # update to the latest version
pi remove npm:pi-prompt-suggestion  # uninstall
```

## Usage

After the second assistant reply, once the input box has been empty and idle for 20 seconds, a predicted next message appears as dimmed text in the input box:

| Key | Action |
|---|---|
| Tab | Accept the suggestion (inserts it into the input box; press Enter to send) |
| Tab (empty box, nothing shown) | Generate a suggestion now instead of waiting |
| Esc | Dismiss the suggestion |
| Any other key | Type normally; the suggestion hides and comes back when the box is empty again |

Run `/suggestion` to change settings: turn it on or off, the idle delay, maximum length, context mode (`segment` is cheap, `fork` reuses the session's prompt cache for better suggestions), or a separate model. Changes are saved to `~/.pi/agent/prompt-suggestion.json` and apply immediately. See the [extension README](prompt-suggestion/README.md) for every setting.

Each suggestion is one extra model request. To stop all requests, use `/suggestion` → Enabled → off.

## Development

Each extension lives in its own folder with an `index.ts` entry point. pi loads TypeScript directly, so there is no build step.

To use a local checkout instead of the npm package, remove the npm package and add the folder to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/project/pi-extension/prompt-suggestion"]
}
```

Run `/reload` inside pi after editing the code. To try one extension in isolation:

```bash
pi -ne --no-mcp -e ./prompt-suggestion --no-session
```

To publish a new version: bump `version` in the extension's `package.json`, then run `npm publish` in its folder.

## License

MIT
