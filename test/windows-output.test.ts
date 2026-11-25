import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MonitorManager, type MonitorRecord } from "../src/monitor-manager.ts";

test("captures Windows PowerShell output and fires on a match", { skip: process.platform !== "win32" }, async () => {
  const { promise: wake, resolve } = Promise.withResolvers<MonitorRecord>();
  const mgr = new MonitorManager({ now: Date.now, wake: resolve, changed: () => {} });
  try {
    mgr.createProcess({
      command: `powershell.exe -NoLogo -NoProfile -Command "[Console]::Out.WriteLine('monitor-ready')"`,
      match: "^monitor-ready$",
      timeoutSeconds: 0,
    });
    const record = await wake;
    const output = readFileSync(record.outputPath!, "utf8");
    assert.deepEqual({ cause: record.cause, output: output.trim() }, {
      cause: { kind: "matched", line: "monitor-ready" },
      output: "monitor-ready",
    });
  } finally {
    mgr.shutdown();
  }
});
