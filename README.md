# pi-monitor

Wake the agent once when a background command finishes, matches output, or goes quiet. No polling.

> **Status:** early development. Not yet published.

## Why

Agents often stall by polling: `sleep 15 && curl ...`, or a `while` loop that checks until something is ready. That burns tokens, hides progress, and wedges the turn when the check stalls.

`pi-monitor` lets the agent step away instead. It runs the command in the background and wakes the agent exactly once, when something worth acting on happens:

- the command exits,
- its output matches a pattern (e.g. `listening on :3000`),
- or it goes quiet for too long.

## Design

- **One job.** Watch one background command and wake the agent once.
- **One-shot.** Fires once, then retires. Re-arm explicitly if you want to watch again.
- **Interrupt-driven.** Zero tokens while waiting.
- **Pure core.** The condition logic is a standalone, unit-tested module with no timers, processes, or I/O.

## License

MIT
