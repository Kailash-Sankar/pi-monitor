/**
 * Spawn, capture, and lifecycle for monitors.
 *
 * Decoupled from pi: it reports through injected hooks (wake / changed) so the
 * extension entry point owns messaging and UI. No polling of the agent is
 * involved — the agent is woken once, on a condition.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConditionMatcher, type FireReason } from "./matcher.ts";

export type MonitorKind = "process" | "timer";
export type MonitorStatus = "running" | "fired" | "stopped";

/** Why a monitor fired. Process conditions come from the matcher. */
export type FireCause = FireReason | { kind: "elapsed"; afterMs: number };

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
  status: MonitorStatus;
  cause?: FireCause;
  firedAt?: number;
}

export interface ManagerHooks {
  /** Deliver the wake to the agent. Called once per monitor. */
  wake(record: MonitorRecord): void;
  /** Something changed; refresh UI. */
  changed(): void;
  /** Clock, injectable for tests. */
  now(): number;
}

interface Entry {
  record: MonitorRecord;
  matcher?: ConditionMatcher;
  child?: ReturnType<typeof spawn>;
  timer?: ReturnType<typeof setTimeout>;
  interval?: ReturnType<typeof setInterval>;
  stream?: ReturnType<typeof createWriteStream>;
  buffer: string;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Kill an entire process tree. Because children are spawned detached, their pid
 * is the process-group id, so a negative pid signals the whole group. Escalates
 * to SIGKILL if the group is still alive shortly after SIGTERM.
 */
function killTree(child: ReturnType<typeof spawn> | undefined): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
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
  private seq = 0;

  constructor(hooks: ManagerHooks) {
    this.hooks = hooks;
  }

  createProcess(opts: {
    command: string;
    match?: string;
    timeoutSeconds?: number;
    label?: string;
    onDone?: string;
    cwd?: string;
  }): MonitorRecord {
    const now = this.hooks.now();
    const id = String(++this.seq);
    const dir = mkdtempSync(join(tmpdir(), "pi-monitor-"));
    const outputPath = join(dir, "output.log");
    const stream = createWriteStream(outputPath, { flags: "a" });
    const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    // Throws on an invalid pattern, before anything is spawned.
    const matcher = new ConditionMatcher({ match: opts.match, timeoutMs }, now);

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
    const entry: Entry = { record, matcher, stream, buffer: "" };
    this.entries.set(id, entry);

    // detached spawns its own process group so we can kill the whole tree.
    // Killing just the shell would orphan grandchildren (e.g. `sh -c 'a; b'`).
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.child = child;

    const onChunk = (chunk: Buffer): void => {
      stream.write(chunk);
      entry.buffer += chunk.toString();
      let idx = entry.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = entry.buffer.slice(0, idx);
        entry.buffer = entry.buffer.slice(idx + 1);
        const cause = matcher.onLine(line, this.hooks.now());
        if (cause) {
          this.fire(id, cause);
          return;
        }
        idx = entry.buffer.indexOf("\n");
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    if (timeoutMs > 0) {
      const interval = setInterval(() => {
        const cause = matcher.onTick(this.hooks.now());
        if (cause) this.fire(id, cause);
      }, Math.min(1000, timeoutMs));
      interval.unref?.();
      entry.interval = interval;
    }

    const settle = (code: number | null, signal: string | null): void => {
      stream.end();
      if (entry.interval) clearInterval(entry.interval);
      // Flush a trailing partial line so the final output is still matched.
      if (entry.buffer.length > 0) {
        const cause = matcher.onLine(entry.buffer, this.hooks.now());
        entry.buffer = "";
        if (cause) {
          this.fire(id, cause);
          return;
        }
      }
      const cause = matcher.onExit(code, signal);
      if (cause) this.fire(id, cause);
    };

    child.on("exit", (code, signal) => settle(code, signal));
    child.on("error", () => settle(null, "spawn error"));

    this.hooks.changed();
    return record;
  }

  createTimer(opts: { prompt: string; delaySeconds: number; label?: string }): MonitorRecord {
    const now = this.hooks.now();
    const id = String(++this.seq);
    const afterMs = Math.max(0, opts.delaySeconds) * 1000;
    const record: MonitorRecord = {
      id,
      kind: "timer",
      label: opts.label ?? `check in ${opts.delaySeconds}s`,
      prompt: opts.prompt,
      startedAt: now,
      status: "running",
    };
    const entry: Entry = { record, buffer: "" };
    this.entries.set(id, entry);

    const timer = setTimeout(() => {
      this.fire(id, { kind: "elapsed", afterMs });
    }, afterMs);
    timer.unref?.();
    entry.timer = timer;

    this.hooks.changed();
    return record;
  }

  list(): MonitorRecord[] {
    return [...this.entries.values()].map((e) => e.record);
  }

  get(id: string): MonitorRecord | undefined {
    return this.entries.get(id)?.record;
  }

  /** Stop a monitor without waking the agent. Returns false if unknown. */
  stop(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.record.status === "running") {
      entry.record.status = "stopped";
      if (entry.interval) clearInterval(entry.interval);
      if (entry.timer) clearTimeout(entry.timer);
      killTree(entry.child);
      entry.stream?.end();
    }
    this.hooks.changed();
    return true;
  }

  /** Stop everything. Idempotent. Safe to call from session_shutdown. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      if (entry.interval) clearInterval(entry.interval);
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.record.status === "running") killTree(entry.child);
      entry.stream?.end();
    }
    this.entries.clear();
  }

  private fire(id: string, cause: FireCause): void {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "running") return;
    entry.record.status = "fired";
    entry.record.cause = cause;
    entry.record.firedAt = this.hooks.now();
    if (entry.interval) clearInterval(entry.interval);
    if (entry.timer) clearTimeout(entry.timer);
    killTree(entry.child);
    this.hooks.wake(entry.record);
    this.hooks.changed();
  }
}
