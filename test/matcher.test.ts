import { test } from "node:test";
import assert from "node:assert/strict";
import { ConditionMatcher } from "../src/matcher.ts";

test("fires when an output line matches", () => {
  const m = new ConditionMatcher({ match: "listening on" }, 0);
  assert.equal(m.onLine("starting up", 10), null);
  assert.deepEqual(m.onLine("server listening on :3000", 20), {
    kind: "matched",
    line: "server listening on :3000",
  });
  assert.equal(m.done, true);
});

test("does not fire on non-matching output", () => {
  const m = new ConditionMatcher({ match: "ready" }, 0);
  assert.equal(m.onLine("booting", 10), null);
  assert.equal(m.done, false);
});

test("rejects an invalid match pattern", () => {
  assert.throws(() => new ConditionMatcher({ match: "([unclosed" }, 0), /invalid match pattern/);
});

test("is one-shot: no further fires after a match", () => {
  const m = new ConditionMatcher({ match: "ready" }, 0);
  assert.notEqual(m.onLine("ready", 10), null);
  assert.equal(m.onLine("ready again", 20), null);
  assert.equal(m.onExit(0), null);
  assert.equal(m.onTick(100000), null);
});

test("is case-sensitive by default but honours the i flag", () => {
  const sensitive = new ConditionMatcher({ match: "listening" }, 0);
  assert.equal(sensitive.onLine("Listening on :3000", 1), null);

  const insensitive = new ConditionMatcher({ match: "listening", flags: "i" }, 0);
  assert.notEqual(insensitive.onLine("Listening on :3000", 1), null);
});

test("rejects invalid flags", () => {
  assert.throws(() => new ConditionMatcher({ match: "x", flags: "zz" }, 0), /invalid match pattern/);
});

test("fires on exit with code and signal", () => {
  const m = new ConditionMatcher({}, 0);
  assert.deepEqual(m.onExit(1), { kind: "exited", code: 1, signal: null });
});

test("exit does not fire twice", () => {
  const m = new ConditionMatcher({}, 0);
  assert.notEqual(m.onExit(0), null);
  assert.equal(m.onExit(0), null);
});

test("quiet threshold fires only after silence exceeds it", () => {
  const m = new ConditionMatcher({ timeoutMs: 5000 }, 0);
  assert.equal(m.onTick(4999), null);
  assert.deepEqual(m.onTick(5000), { kind: "quiet", silentMs: 5000 });
});

test("output renews the quiet deadline", () => {
  const m = new ConditionMatcher({ timeoutMs: 5000 }, 0);
  m.onLine("still working", 4000);
  assert.equal(m.onTick(8000), null);
  assert.deepEqual(m.onTick(9000), { kind: "quiet", silentMs: 5000 });
});

test("quiet detection is disabled when timeoutMs is 0 or omitted", () => {
  const m = new ConditionMatcher({}, 0);
  assert.equal(m.onTick(10_000_000), null);
});

test("a match beats a later quiet tick", () => {
  const m = new ConditionMatcher({ match: "done", timeoutMs: 1000 }, 0);
  assert.notEqual(m.onLine("done", 500), null);
  assert.equal(m.onTick(9999), null);
});
