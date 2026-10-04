import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  MonitorManager,
  type ManagerHooks,
  type MonitorRecord,
} from "../src/monitor-manager.ts";

class FakeChild extends EventEmitter {
  // No pid so killTree cannot signal a real process group during tests.
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
  out(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
  err(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }
  fail(message: string): void {
    this.emit("error", new Error(message));
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const woken: MonitorRecord[] = [];
  let clock = 1000;
  const hooks: ManagerHooks = {
    now: () => clock,
    wake: (r) => woken.push(r),
    changed: () => {},
  };
  const children: FakeChild[] = [];
  const spawner = ((_cmd: string, _opts: unknown) => {
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof import("node:child_process").spawn;
  const mgr = new MonitorManager(hooks, { spawn: spawner });
  return {
    mgr,
    woken,
    children,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("fires on a matching line and never again", () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x", match: "ready" });
  children[0].out("ready\n");
  assert.equal(woken.length, 1);
  assert.equal(woken[0].cause?.kind, "matched");
  children[0].exit(0);
  assert.equal(woken.length, 1, "exit after a match must not wake again");
  mgr.shutdown();
});

test("fires on exit and records the exit code", () => {
  const { mgr, woken, children } = setup();
  const record = mgr.createProcess({ command: "x" });
  children[0].exit(3);
  assert.equal(woken.length, 1);
  assert.equal(woken[0].cause?.kind, "exited");
  assert.equal(record.exitCode, 3);
  mgr.shutdown();
});

test("a trailing partial line is matched at exit", () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x", match: "ready" });
  children[0].out("ready"); // no newline
  assert.equal(woken.length, 0);
  children[0].exit(0);
  assert.equal(woken.length, 1);
  assert.equal(woken[0].cause?.kind, "matched");
  mgr.shutdown();
});

test("stop prevents any later wake", () => {
  const { mgr, woken, children } = setup();
  const record = mgr.createProcess({ command: "x", match: "ready" });
  assert.equal(mgr.stop(record.id), "stopped");
  assert.equal(mgr.stop(record.id), "not-running");
  children[0].out("ready\n");
  children[0].exit(0);
  assert.equal(woken.length, 0);
  mgr.shutdown();
});

test("an invalid match throws before spawning anything", () => {
  const { mgr, children } = setup();
  assert.throws(() => mgr.createProcess({ command: "x", match: "([bad" }), /invalid match pattern/);
  assert.equal(children.length, 0);
  mgr.shutdown();
});

test("spawn failure wakes with an error cause", () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x" });
  children[0].fail("boom");
  assert.equal(woken.length, 1);
  assert.equal(woken[0].cause?.kind, "error");
  mgr.shutdown();
});

test("rejects negative and oversized time values", () => {
  const { mgr } = setup();
  assert.throws(() => mgr.createProcess({ command: "x", timeoutSeconds: -1 }), /non-negative/);
  assert.throws(() => mgr.createTimer({ prompt: "x", delaySeconds: 1e9 }), /too large/);
  mgr.shutdown();
});

test("enforces a concurrency cap", () => {
  const { mgr } = setup();
  for (let i = 0; i < 25; i++) mgr.createTimer({ prompt: "x", delaySeconds: 60 });
  assert.throws(() => mgr.createTimer({ prompt: "x", delaySeconds: 60 }), /too many running monitors/);
  mgr.shutdown();
});

test("prunes finished monitors after the retention window", () => {
  const { mgr, advance } = setup();
  const record = mgr.createProcess({ command: "x" });
  mgr.stop(record.id);
  assert.equal(mgr.list().length, 1);
  advance(6 * 60 * 1000);
  assert.equal(mgr.list().length, 0);
  mgr.shutdown();
});

test("pruning removes the temp output directory", async () => {
  const { mgr, advance } = setup();
  const record = mgr.createProcess({ command: "x" });
  const dir = dirname(record.outputPath!);
  assert.equal(existsSync(dir), true);
  mgr.stop(record.id);
  advance(6 * 60 * 1000);
  assert.equal(mgr.list().length, 0, "entry should be pruned");
  await delay(100); // disposal happens on stream close
  assert.equal(existsSync(dir), false, "temp dir should be removed on prune");
  mgr.shutdown();
});

test("quiet detection fires after the silence threshold", async () => {
  const { mgr, woken, advance } = setup();
  mgr.createProcess({ command: "x", timeoutSeconds: 0.15 });
  advance(1000); // silence now exceeds the 150ms threshold
  await delay(300); // let the real interval tick
  assert.equal(woken.length, 1);
  assert.equal(woken[0].cause?.kind, "quiet");
  mgr.shutdown();
});
