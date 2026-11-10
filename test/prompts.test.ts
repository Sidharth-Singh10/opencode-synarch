import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ORCHESTRATOR_CONTEXT } from "../src/prompts.js";
import { ROLE_BRIEFS } from "../src/protocol.js";

const agent = readFileSync(join(process.cwd(), "agents", "synarch.md"), "utf8");

test("the agent prompt and the runtime context agree on crew-first", () => {
  for (const text of [agent, ORCHESTRATOR_CONTEXT]) {
    assert.match(text, /do not (change source files|edit source)/i);
    assert.match(text, /actor/i);
    assert.match(text, /jury/i);
    assert.doesNotMatch(text, /small tasks are yours|handle small tasks directly/i);
  }
  assert.match(agent, /synarch_delegate/);
});

test("role briefs encode the authority boundaries", () => {
  assert.match(ROLE_BRIEFS.jury, /technical decision authority/i);
  assert.match(ROLE_BRIEFS.jury, /decision ledger/i);
  assert.match(ROLE_BRIEFS.actor, /cannot accept your own work/i);
  assert.match(ROLE_BRIEFS.critic, /advisory/i);
  assert.match(ROLE_BRIEFS.critic, /Do not modify production code/i);
  assert.match(ROLE_BRIEFS.qa, /release-blocking/i);
  assert.match(ROLE_BRIEFS.qa, /after the Jury accepts/i);
});
