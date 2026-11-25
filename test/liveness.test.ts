import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorManager, type MonitorRecord } from "../src/monitor-manager.ts";

test("liveness tracks running processes and pending timers, not retained records", async () => {
  const { promise: wake, resolve } = Promise.withResolvers<MonitorRecord>();
  const mgr = new MonitorManager({ now: Date.now, wake: resolve, changed: () => {} });
  try {
    assert.equal(mgr.hasRunning(), false);
    const processMonitor = mgr.createProcess({
      command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,
      timeoutSeconds: 0,
    });
    assert.equal(mgr.hasRunning(), true);
    mgr.stop(processMonitor.id);
    assert.equal(mgr.hasRunning(), false);

    const timer = mgr.createTimer({ prompt: "wake", delaySeconds: 0 });
    assert.equal(mgr.hasRunning(), true);
    // CheckLater timers are unref'ed: keep this test alive until the wake hook runs.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.equal((await wake).id, timer.id);
    } finally {
      clearTimeout(keepAlive);
    }
    assert.deepEqual(mgr.list().map((record) => record.status), ["stopped", "fired"]);
    assert.equal(mgr.hasRunning(), false);
  } finally {
    mgr.shutdown();
  }
});
