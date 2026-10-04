import "./source-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { BodyTooLargeError, readBoundedBody } from "../src/bounded-body.ts";
import { readBoundedText } from "../.test-tmp/mcp.mjs";

function stream(chunks, { cancelError, readError } = {}) {
  let index = 0;
  const calls = { cancelled: 0, reads: 0 };
  const body = new ReadableStream({
    pull(controller) {
      calls.reads++;
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else if (readError) controller.error(readError);
      else controller.close();
    },
    cancel() { calls.cancelled++; if (cancelError) throw cancelError; },
  }, { highWaterMark: 0 });
  return { body, calls };
}

test("bounded bytes accept the exact cap and release the reader", async () => {
  const { body, calls } = stream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  assert.deepEqual(await readBoundedBody(body, 4), new Uint8Array([1, 2, 3, 4]));
  assert.equal(body.locked, false);
  assert.equal(calls.cancelled, 0);
});

test("bounded bytes cancel immediately above the cap and release on cancel failure", async () => {
  for (const ignoreCancelErrors of [false, true]) {
    for (const cancelError of [undefined, new Error("cancel failed")]) {
      const { body, calls } = stream([new Uint8Array(4), new Uint8Array(1), new Uint8Array(1)], { cancelError });
      await assert.rejects(readBoundedBody(body, 4, { ignoreCancelErrors }), error => {
        assert.ok(cancelError && !ignoreCancelErrors ? error === cancelError : error instanceof BodyTooLargeError);
        return true;
      });
      assert.equal(calls.cancelled, 1);
      assert.equal(calls.reads, 2, "must not read beyond the first oversized chunk");
      assert.equal(body.locked, false);
    }
  }
});

test("bounded bytes preserve read errors and release the reader", async () => {
  const readError = new Error("read failed");
  const { body } = stream([new Uint8Array(1)], { readError });
  await assert.rejects(readBoundedBody(body, 4), error => error === readError);
  assert.equal(body.locked, false);
});

test("MCP preserves byte caps, split UTF-8, replacement decoding and public body errors", async () => {
  const makeRequest = body => new Request("https://relay.example/mcp", { method: "POST", body, duplex: "half" });
  const bytes = new TextEncoder().encode("é");
  const exact = stream([bytes.subarray(0, 1), bytes.subarray(1)]);
  assert.deepEqual(await readBoundedText(makeRequest(exact.body), 2), { ok: true, text: "é" });
  assert.equal(exact.body.locked, false);
  const malformed = stream([new Uint8Array([0xc3])]);
  assert.deepEqual(await readBoundedText(makeRequest(malformed.body), 1), { ok: true, text: "\uFFFD" });
  assert.equal(malformed.body.locked, false);
  const oversized = stream([bytes], { cancelError: new Error("cancel failed") });
  assert.deepEqual(await readBoundedText(makeRequest(oversized.body), 1), { ok: false, status: 413, message: "Payload Too Large" });
  assert.equal(oversized.calls.cancelled, 1);
  assert.equal(oversized.body.locked, false);
  const broken = stream([], { readError: new Error("read failed") });
  assert.deepEqual(await readBoundedText(makeRequest(broken.body), 2), { ok: false, status: 400, message: "Bad request body" });
  assert.equal(broken.body.locked, false);
});
