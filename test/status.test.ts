import assert from "node:assert/strict";
import test from "node:test";

import { isSessionRunning } from "../src/status.js";

test("a busy timestamp newer than idle means running", () => {
  assert.equal(isSessionRunning({ time: { busy: 20, idle: 10 } }, "idle"), true);
  assert.equal(isSessionRunning({ time: { busy: 10, idle: 20 } }, "idle"), false);
  assert.equal(isSessionRunning({ time: { busy: 10, idle: 10 } }, "idle"), false);
  assert.equal(isSessionRunning({ time: {} }, "idle"), false);
  assert.equal(isSessionRunning(undefined, "idle"), false);
});

test("the live status wins when it already says running", () => {
  assert.equal(isSessionRunning({ time: { busy: 10, idle: 20 } }, "running"), true);
  assert.equal(isSessionRunning(undefined, "running"), true);
});
