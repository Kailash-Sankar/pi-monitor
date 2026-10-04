import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
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
  /** Process ended, but stdio may still be open. */
  exitOnly(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
  /** Process ended and stdio closed, which is the manager's finalize signal. */
  close(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
  out(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
  fail(message: string): void {
    this.emit("error", new Error(message));
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until a condition holds, or throw. Wake delivery is now deferred. */
async function until(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await delay(10);
  }
}

function makeSpawner(children: FakeChild[]) {
  return ((_cmd: string, _opts: unknown) => {
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof import("node:child_process").spawn;
}

function setup() {
  const woken: MonitorRecord[] = [];
  let clock = 1000;
  const children: FakeChild[] = [];
  const hooks: ManagerHooks = {
    now: () => clock,
    wake: (r) => woken.push(r),
    changed: () => {},
  };
  const mgr = new MonitorManager(hooks, { spawn: makeSpawner(children) });
  return {
    mgr,
    woken,
    children,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("fires on a matching line and never again", async () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x", match: "ready" });
  children[0].out("ready\n");
  await until(() => woken.length === 1);
  assert.equal(woken[0].cause?.kind, "matched");
  children[0].close(0);
  await delay(50);
  assert.equal(woken.length, 1, "close after a match must not wake again");
  mgr.shutdown();
});

test("fires on exit and records the exit code", async () => {
  const { mgr, woken, children } = setup();
  const record = mgr.createProcess({ command: "x" });
  children[0].close(3);
  await until(() => woken.length === 1);
  assert.equal(woken[0].cause?.kind, "exited");
  assert.equal(record.exitCode, 3);
  mgr.shutdown();
});

test("a trailing partial line is matched at exit", async () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x", match: "ready" });
  children[0].out("ready"); // no newline
  await delay(30);
  assert.equal(woken.length, 0);
  children[0].close(0);
  await until(() => woken.length === 1);
  assert.equal(woken[0].cause?.kind, "matched");
  mgr.shutdown();
});

test("stop prevents any later wake", async () => {
  const { mgr, woken, children } = setup();
  const record = mgr.createProcess({ command: "x", match: "ready" });
  assert.equal(mgr.stop(record.id), "stopped");
  assert.equal(mgr.stop(record.id), "not-running");
  children[0].out("ready\n");
  children[0].close(0);
  await delay(50);
  assert.equal(woken.length, 0);
  mgr.shutdown();
});

test("an invalid match throws before spawning anything", () => {
  const { mgr, children } = setup();
  assert.throws(() => mgr.createProcess({ command: "x", match: "([bad" }), /invalid match pattern/);
  assert.equal(children.length, 0);
  mgr.shutdown();
});

test("spawn failure wakes with an error cause", async () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x" });
  children[0].fail("boom");
  await until(() => woken.length === 1);
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

test("finalizes on close, not exit, so late stdout is not dropped", async () => {
  const { mgr, woken, children } = setup();
  mgr.createProcess({ command: "x" });
  children[0].exitOnly(0);
  await delay(30);
  assert.equal(woken.length, 0, "must not finalize on exit while stdio is open");
  children[0].close(0);
  await until(() => woken.length === 1);
  mgr.shutdown();
});

test("quiet detection fires after the silence threshold", async () => {
  const { mgr, woken, advance } = setup();
  mgr.createProcess({ command: "x", timeoutSeconds: 0.15 });
  advance(1000); // silence now exceeds the 150ms threshold
  await until(() => woken.length === 1);
  assert.equal(woken[0].cause?.kind, "quiet");
  mgr.shutdown();
});

test("newline-free output renews the quiet deadline", async () => {
  const woken: MonitorRecord[] = [];
  const children: FakeChild[] = [];
  const mgr = new MonitorManager(
    { now: () => Date.now(), wake: (r) => woken.push(r), changed: () => {} },
    { spawn: makeSpawner(children) },
  );
  // timeout 300ms; emit a small chunk every 50ms with no newline for 400ms
  mgr.createProcess({ command: "x", timeoutSeconds: 0.3 });
  for (let i = 0; i < 8; i++) {
    children[0].out("tick ");
    await delay(50);
  }
  assert.equal(woken.length, 0, "activity should have renewed the deadline");
  await until(() => woken.some((w) => w.cause?.kind === "quiet"));
  mgr.shutdown();
});

test("the wake hook sees a fully written capture file", async () => {
  const children: FakeChild[] = [];
  let captured = "";
  const mgr = new MonitorManager(
    {
      now: () => Date.now(),
      changed: () => {},
      wake: (r) => {
        // Read synchronously at wake time: the file must already be complete.
        captured = readFileSync(r.outputPath!, "utf8");
      },
    },
    { spawn: makeSpawner(children) },
  );
  mgr.createProcess({ command: "x", match: "DONE" });
  children[0].out("hello ");
  children[0].out("world\n");
  children[0].out("DONE\n");
  await until(() => captured !== "");
  assert.match(captured, /hello world/);
  assert.match(captured, /DONE/);
  mgr.shutdown();
});
