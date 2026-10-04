import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineReader } from "../src/lines.ts";

function collect() {
  const lines: string[] = [];
  return { lines, reader: createLineReader((l) => lines.push(l)) };
}

test("emits complete lines without the newline", () => {
  const { lines, reader } = collect();
  reader.write(Buffer.from("one\ntwo\nthr"));
  assert.deepEqual(lines, ["one", "two"]);
  reader.write(Buffer.from("ee\n"));
  assert.deepEqual(lines, ["one", "two", "three"]);
});

test("strips a trailing carriage return (CRLF)", () => {
  const { lines, reader } = collect();
  reader.write(Buffer.from("done\r\nnext\r\n"));
  assert.deepEqual(lines, ["done", "next"]);
});

test("reassembles a multi-byte character split across chunks", () => {
  const { lines, reader } = collect();
  const bytes = Buffer.from("café\n", "utf8"); // é is two bytes
  const split = bytes.indexOf(0xc3); // cut between the two bytes of é
  reader.write(bytes.subarray(0, split + 1));
  reader.write(bytes.subarray(split + 1));
  assert.deepEqual(lines, ["café"]);
});

test("flush emits a trailing fragment with no newline", () => {
  const { lines, reader } = collect();
  reader.write(Buffer.from("partial"));
  assert.deepEqual(lines, []);
  reader.flush();
  assert.deepEqual(lines, ["partial"]);
});

test("flush also completes a split multi-byte character", () => {
  const { lines, reader } = collect();
  const bytes = Buffer.from("héllo", "utf8");
  const split = bytes.indexOf(0xc3);
  reader.write(bytes.subarray(0, split + 1));
  reader.write(bytes.subarray(split + 1));
  assert.deepEqual(lines, []);
  reader.flush();
  assert.deepEqual(lines, ["héllo"]);
});

test("bounds memory by emitting an oversized newline-free fragment", () => {
  const lines: string[] = [];
  const reader = createLineReader((l) => lines.push(l), 100);
  reader.write(Buffer.from("x".repeat(50)));
  assert.equal(lines.length, 0);
  reader.write(Buffer.from("y".repeat(60)));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 110);
});
