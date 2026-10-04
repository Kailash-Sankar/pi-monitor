/**
 * Spawn, capture, and lifecycle for monitors.
 *
 * Decoupled from pi: it reports through injected hooks (wake / changed) so the
 * extension entry point owns messaging and UI. No polling of the agent is
 * involved — the agent is woken once, on a condition.
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConditionMatcher, type FireReason } from "./matcher.ts";
import { createLineReader } from "./lines.ts";

export type MonitorKind = "process" | "timer";
export type MonitorStatus = "running" | "fired" | "stopped";

/** Why a monitor fired. Process conditions come from the matcher. */
export type FireCause =
  | FireReason
  | { kind: "elapsed"; afterMs: number }
  | { kind: "error"; message: string };

export interface MonitorRecord {
  id: string;
  kind: MonitorKind;
  label: string;
  /** process monitors */
  command?: string;
  outputPath?: string;
  exitCode?: number | null;
  /** timer monitors */
  prompt?: string;
  /** instruction delivered to the agent on wake */
  onDone?: string;
  startedAt: number;
  /** when the monitor left the running state (fired or stopped) */
  endedAt?: number;
  status: MonitorStatus;
  cause?: FireCause;
  firedAt?: number;
}

/** Outcome of stopping a monitor, so callers can report accurately. */
export type StopResult = "stopped" | "not-running" | "unknown";

export interface ManagerHooks {
  /** Deliver the wake to the agent. Called once per monitor. */
  wake(record: MonitorRecord): void;
  /** Something changed; refresh UI. */
  changed(): void;
  /** Clock, injectable for tests. */
  now(): number;
}

export interface ManagerOptions {
  /** Process spawner. Injectable so the lifecycle can be tested without processes. */
  spawn?: typeof spawn;
}

interface Entry {
  record: MonitorRecord;
  matcher?: ConditionMatcher;
  child?: ReturnType<typeof spawn>;
  timer?: ReturnType<typeof setTimeout>;
  interval?: ReturnType<typeof setInterval>;
  stream?: ReturnType<typeof createWriteStream>;
  dir?: string;
  written: number;
  wakeSent?: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Node clamps setTimeout delays above this and fires almost immediately. */
const MAX_TIMER_MS = 2_147_483_647;
/** Cap on simultaneously running monitors. */
const MAX_RUNNING_MONITORS = 25;
/** How long a finished monitor stays listed before being pruned. */
const RETAIN_FINISHED_MS = 5 * 60 * 1000;

/**
 * Kill an entire process tree. Because children are spawned detached, their pid
 * is the process-group id on POSIX, so a negative pid signals the whole group.
 * This runs on every fire, including a clean exit, so a command that backgrounds
 * a child and exits does not leave that child orphaned. Escalates to SIGKILL if
 * the group is still alive shortly after SIGTERM.
 *
 * On Windows the group model differs, so `taskkill /T /F` is used instead. That
 * path is untested here (developed on macOS).
 */
function killTree(child: ReturnType<typeof spawn> | undefined): void {
  if (!child || child.pid === undefined) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    return;
  }

  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  signalGroup("SIGTERM");
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 0); // probe: still alive?
      signalGroup("SIGKILL");
    } catch {
      // gone
    }
  }, 2000);
  escalate.unref?.();
}

export class MonitorManager {
  private readonly entries = new Map<string, Entry>();
  private readonly hooks: ManagerHooks;
  private readonly spawnProcess: typeof spawn;
  private seq = 0;
  private shuttingDown = false;

  constructor(hooks: ManagerHooks, options: ManagerOptions = {}) {
    this.hooks = hooks;
    this.spawnProcess = options.spawn ?? spawn;
  }

  /** Current clock, from the injected hooks. */
  now(): number {
    return this.hooks.now();
  }

  createProcess(opts: {
    command: string;
    match?: string;
    flags?: string;
    timeoutSeconds?: number;
    label?: string;
    onDone?: string;
    cwd?: string;
  }): MonitorRecord {
    this.assertCapacity();
    const now = this.hooks.now();
    const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      throw new Error("timeoutSeconds must be a non-negative number");
    }
    const timeoutMs = timeoutSeconds * 1000;

    // Build the matcher first: an invalid pattern must throw before any
    // temp dir or file handle is created.
    const matcher = new ConditionMatcher(
      { match: opts.match, flags: opts.flags, timeoutMs },
      now,
    );

    const id = String(++this.seq);
    const dir = mkdtempSync(join(tmpdir(), "pi-monitor-"));
    const outputPath = join(dir, "output.log");
    const stream = createWriteStream(outputPath, { flags: "a" });
    // Capture is best effort: a file error must never crash the host.
    stream.on("error", () => {});

    const record: MonitorRecord = {
      id,
      kind: "process",
      label: opts.label ?? opts.command,
      command: opts.command,
      onDone: opts.onDone,
      startedAt: now,
      outputPath,
      status: "running",
    };
    const entry: Entry = { record, matcher, stream, dir, written: 0 };
    this.entries.set(id, entry);

    // detached spawns its own process group so we can kill the whole tree.
    // Killing just the shell would orphan grandchildren (e.g. `sh -c 'a; b'`).
    const child = this.spawnProcess(opts.command, {
      shell: true,
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.child = child;

    // Cap the captured log so a chatty command cannot fill the disk.
    const writeOut = (chunk: Buffer): void => {
      if (stream.writableEnded || stream.destroyed) return;
      if (entry.written >= MAX_LOG_BYTES) return;
      const remaining = MAX_LOG_BYTES - entry.written;
      if (chunk.length <= remaining) {
        stream.write(chunk);
        entry.written += chunk.length;
        return;
      }
      stream.write(chunk.subarray(0, remaining));
      entry.written = MAX_LOG_BYTES;
      stream.write("\n[pi-monitor: output truncated]\n");
    };

    const handleLine = (line: string): void => {
      const cause = matcher.onLine(line, this.hooks.now());
      if (cause) this.fire(id, cause);
    };

    // Separate readers and buffers per stream, so interleaved stdout/stderr
    // cannot synthesize a line that never existed.
    const stdoutReader = createLineReader(handleLine, MAX_LINE_LENGTH);
    const stderrReader = createLineReader(handleLine, MAX_LINE_LENGTH);

    child.stdout?.on("data", (chunk: Buffer) => {
      matcher.onActivity(this.hooks.now());
      writeOut(chunk);
      stdoutReader.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      matcher.onActivity(this.hooks.now());
      writeOut(chunk);
      stderrReader.write(chunk);
    });

    if (timeoutMs > 0) {
      const interval = setInterval(() => {
        const cause = matcher.onTick(this.hooks.now());
        if (cause) this.fire(id, cause);
      }, Math.max(100, Math.min(1000, timeoutMs)));
      interval.unref?.();
      entry.interval = interval;
    }

    let settled = false;
    const settle = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (entry.interval) clearInterval(entry.interval);
      // Flush trailing fragments so the final line is still matched.
      stdoutReader.flush();
      stderrReader.flush();
      stream.end();
      const cause = matcher.onExit(code, signal);
      if (cause) this.fire(id, cause);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (entry.interval) clearInterval(entry.interval);
      stdoutReader.flush();
      stderrReader.flush();
      stream.end();
      this.fire(id, { kind: "error", message });
    };

    // Use "close", not "exit": close fires after stdout/stderr have been fully
    // drained. Finalizing on "exit" can drop output still in the pipe.
    child.on("close", (code, signal) => settle(code, signal));
    child.on("error", (err) => fail(err.message));

    this.hooks.changed();
    return record;
  }

  createTimer(opts: { prompt: string; delaySeconds: number; label?: string }): MonitorRecord {
    this.assertCapacity();
    const delaySeconds = opts.delaySeconds;
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
      throw new Error("delaySeconds must be a non-negative number");
    }
    const afterMs = delaySeconds * 1000;
    if (afterMs > MAX_TIMER_MS) {
      throw new Error(
        `delaySeconds is too large (max ${Math.floor(MAX_TIMER_MS / 1000)})`,
      );
    }

    const now = this.hooks.now();
    const id = String(++this.seq);
    const record: MonitorRecord = {
      id,
      kind: "timer",
      label: opts.label ?? `check in ${delaySeconds}s`,
      prompt: opts.prompt,
      startedAt: now,
      status: "running",
    };
    const entry: Entry = { record, written: 0 };
    this.entries.set(id, entry);

    const timer = setTimeout(() => {
      this.fire(id, { kind: "elapsed", afterMs });
    }, afterMs);
    timer.unref?.();
    entry.timer = timer;

    this.hooks.changed();
    return record;
  }

  /** List monitors, pruning finished ones past the retention window. */
  list(): MonitorRecord[] {
    this.prune();
    return [...this.entries.values()].map((e) => e.record);
  }

  /** Stop a running monitor without waking the agent. */
  stop(id: string): StopResult {
    const entry = this.entries.get(id);
    if (!entry) return "unknown";
    if (entry.record.status !== "running") return "not-running";
    entry.record.status = "stopped";
    entry.record.endedAt = this.hooks.now();
    if (entry.interval) clearInterval(entry.interval);
    if (entry.timer) clearTimeout(entry.timer);
    killTree(entry.child);
    entry.stream?.end();
    this.hooks.changed();
    return "stopped";
  }

  /** Stop everything and remove temp output. Idempotent. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const entry of this.entries.values()) {
      if (entry.interval) clearInterval(entry.interval);
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.record.status === "running") killTree(entry.child);
      this.dispose(entry);
    }
    this.entries.clear();
  }

  /**
   * Close a monitor's output stream and remove its temp dir once the stream is
   * fully closed. Removing the dir before the flush finishes races the write.
   */
  private dispose(entry: Entry): void {
    const dir = entry.dir;
    const stream = entry.stream;
    if (!dir) return;
    const removeDir = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    };
    if (!stream || stream.closed) {
      removeDir();
      return;
    }
    stream.once("close", removeDir);
    try {
      stream.end();
    } catch {
      // already ending
    }
  }

  private assertCapacity(): void {
    let running = 0;
    for (const entry of this.entries.values()) {
      if (entry.record.status === "running") running++;
    }
    if (running >= MAX_RUNNING_MONITORS) {
      throw new Error(
        `too many running monitors (max ${MAX_RUNNING_MONITORS}); stop one first`,
      );
    }
  }

  private prune(): void {
    const now = this.hooks.now();
    for (const [id, entry] of this.entries) {
      if (entry.record.status === "running") continue;
      const endedAt = entry.record.endedAt ?? entry.record.startedAt;
      if (now - endedAt >= RETAIN_FINISHED_MS) {
        this.dispose(entry);
        this.entries.delete(id);
      }
    }
  }

  private fire(id: string, cause: FireCause): void {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "running") return;
    const now = this.hooks.now();
    entry.record.status = "fired";
    entry.record.cause = cause;
    entry.record.firedAt = now;
    entry.record.endedAt = now;
    if (cause.kind === "exited") entry.record.exitCode = cause.code;
    if (entry.interval) clearInterval(entry.interval);
    if (entry.timer) clearTimeout(entry.timer);
    killTree(entry.child);
    this.hooks.changed();
    this.deliverWake(entry);
  }

  /**
   * Deliver the wake only once the capture stream has closed, so the outputPath
   * in the wake message is complete. A match fire ends the stream here; exit and
   * quiet fires have already ended it in settle(). Waking on "close" also covers
   * a failed stream, which emits "close" without "finish".
   */
  private deliverWake(entry: Entry): void {
    if (entry.wakeSent) return;
    const send = (): void => {
      if (entry.wakeSent || this.shuttingDown) return;
      entry.wakeSent = true;
      this.hooks.wake(entry.record);
    };
    const stream = entry.stream;
    if (!stream || stream.closed || stream.destroyed) {
      send();
      return;
    }
    stream.once("close", send);
    if (!stream.writableEnded) {
      try {
        stream.end();
      } catch {
        // already ending
      }
    }
  }
}
