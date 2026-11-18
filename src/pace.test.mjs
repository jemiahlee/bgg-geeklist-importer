import test from "node:test";
import assert from "node:assert/strict";
import { paced, setRequestDelay } from "./pace.mjs";

test("paced waits the gap after the previous request finished", async () => {
  setRequestDelay(80);
  await paced(async () => {});
  const start = Date.now();
  const result = await paced(async () => "ok");
  assert.equal(result, "ok");
  assert.ok(Date.now() - start >= 80, "second request should wait at least the gap");
});

test("a failed request still counts as a request", async () => {
  setRequestDelay(80);
  await assert.rejects(paced(async () => { throw new Error("boom"); }));
  const start = Date.now();
  await paced(async () => {});
  assert.ok(Date.now() - start >= 80);
});
