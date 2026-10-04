# Changelog

Notable changes to `@ksankar/pi-monitor`.

## 0.1.0

First release.

- `Monitor` — run a shell command in the background and wake the agent once when it exits, matches a pattern, or goes quiet.
- `CheckLater` — wake the agent after a delay, for checks that are not a shell command.
- `MonitorList`, `MonitorStop`, and `/monitors` for inspection and control.
- Live footer status showing the number of running monitors.
- Output captured to a temp file; the wake carries the path plus the fire reason and exit code.
- Commands run in their own process group and are killed as a tree, so grandchildren are not orphaned.
