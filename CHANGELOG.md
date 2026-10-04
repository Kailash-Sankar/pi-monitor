# Changelog

Notable changes to `@ksankar/pi-monitor`.

## 0.2.0

- Prune finished monitors after a 5-minute retention window, so `MonitorList` and `/monitors` do not grow unbounded.
- Cap concurrent monitors at 25 and return a clear error past the limit.
- Kill the process tree on Windows via `taskkill /T /F` (untested; developed on macOS).
- Add `flags` for `match`, e.g. `flags="i"` for case-insensitive matching.
- `MonitorList` now uses the manager's injected clock.
- Add `npm run typecheck` (`tsc --noEmit`) and expand tests: `MonitorManager` lifecycle (fire-once, stop, prune, cap, quiet, errors) and `src/lines.ts`.
- Fix: handle capture-stream errors and remove temp dirs only after the stream closes (previously a race could emit `ENOENT`/write-after-end).

## 0.1.2

Clarity and correctness fixes.

- Document that firing **stops** the command, and that `timeoutSeconds` kills the process group. Replace the misleading dev-server example with a readiness probe (`Monitor` waits for a condition; it does not supervise processes).
- Kill the process group on a clean exit too, so a command that backgrounds a child and exits does not leave orphans.
- Reject an invalid `match` before creating a temp dir or file handle.
- Cap captured output per monitor (5 MB) and cap the newline-free line buffer, so chatty or `\r`-progress output cannot grow unbounded.
- Remove temp output directories on shutdown.
- Split stdout and stderr line handling, decode multi-byte characters across chunks correctly, and strip CRLF.
- Reject negative/non-finite `timeoutSeconds` and `delaySeconds`, and clamp oversized timer delays (previously fired immediately).
- Report spawn failures as a distinct cause instead of a fake signal.
- `MonitorStop` now distinguishes stopped, not-running, and unknown ids.
- Populate the recorded exit code.

## 0.1.1

- Declare host-provided Pi packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) in `peerDependencies`, per Pi package conventions.
- Add `pi.image` gallery preview.
- Document usage with a screenshot.

## 0.1.0

First release.

- `Monitor` — run a shell command in the background and wake the agent once when it exits, matches a pattern, or goes quiet.
- `CheckLater` — wake the agent after a delay, for checks that are not a shell command.
- `MonitorList`, `MonitorStop`, and `/monitors` for inspection and control.
- Live footer status showing the number of running monitors.
- Output captured to a temp file; the wake carries the path plus the fire reason and exit code.
- Commands run in their own process group and are killed as a tree, so grandchildren are not orphaned.
