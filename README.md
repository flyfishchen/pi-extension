# pi-extension

Extensions for the [pi coding agent](https://pi.dev).

| Extension | Description | Install |
|---|---|---|
| [prompt-suggestion](prompt-suggestion/) | Predicts your next message after each turn and shows it as ghost text in the input box (Tab to accept) | `pi install npm:pi-prompt-suggestion` |

## Development

Each extension lives in its own folder with an `index.ts` entry point. pi loads TypeScript directly, so there is no build step.

To use an extension from a local checkout, add its folder to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/project/pi-extension/prompt-suggestion"]
}
```

Run `/reload` inside pi after editing the code. To try one extension in isolation:

```bash
pi -ne --no-mcp -e ./prompt-suggestion --no-session
```

## License

MIT
