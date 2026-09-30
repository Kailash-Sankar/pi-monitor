# pi-monitor

Wake the agent once when a background command finishes, matches output, or goes quiet. No polling.

> **Status:** early development. Not yet published.

## Why

Agents stall by polling: `sleep 15 && curl ...`, or a `while` loop that checks until something is ready. That burns tokens, hides progress, and wedges the turn when the check stalls.

`pi-monitor` lets the agent step away instead. It runs a command in the background and wakes the agent **once**, when something worth acting on happens:

- the command exits,
- its output matches a pattern (e.g. `listening on :3000`),
- or it goes quiet for too long.

It costs zero model tokens while waiting.

## Install

```bash
pi install npm:pi-monitor          # once published
pi install git:github.com/<you>/pi-monitor   # via git
```

Try it locally during development:

```bash
pi -e ./pi-monitor
```

## Tools

### `Monitor` — watch a command

Run a command in the background and wake the agent once on a condition.

```
Monitor command="npm run dev" match="listening on" timeoutSeconds=120 onDone="Run the test suite against the dev server."
```

Returns immediately with an id. Output is captured to a temp file whose path is included in the wake.

| Parameter | Meaning |
|---|---|
| `command` | Shell command to run in the background. |
| `match` | Optional regex. Wake when an output line matches. |
| `timeoutSeconds` | Silence threshold. Any output renews it. Default 300. `0` disables. |
| `onDone` | What to do when it fires — delivered as the wake instruction. |
| `label` | Short human-readable label. |

### `CheckLater` — wake after a delay

For checks the shell cannot observe (an external deployment, an MCP call). **Fallback only** — if the check can be a shell command, use `Monitor`. Each fire costs a turn.

```
CheckLater prompt="Check the deployment status" delaySeconds=60
```

### `MonitorList` / `MonitorStop` / `/monitors`

Inspect and cancel monitors. The footer also shows a live count, e.g. `⏱ 1 monitor`.

## Design

- **One job.** Watch a background command and wake the agent once.
- **One-shot.** Fires once, then retires. Re-arm explicitly to watch again.
- **Interrupt-driven.** Zero tokens while waiting.
- **Process-group aware.** Commands run in their own group; stopping a monitor kills the whole tree, including grandchildren.
- **Pure core.** Condition logic is a standalone, unit-tested module with no timers, processes, or I/O.

## Limitations

- Monitors live in memory and do not survive a Pi restart or session switch.
- `match` is tested against complete lines of output.
- No repeat/recurring mode by design; re-arm explicitly.

## Development

```bash
npm test        # node --test, no install needed (Node >= 22.6)
pi -e ./        # load locally
```

## License

MIT
