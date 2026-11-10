import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChecks,
  runBrief,
  shortTask,
  slug,
  validateProposalInput,
} from "../src/protocol.js";

test("a proposal validates task, repository and checks", () => {
  const result = validateProposalInput({
    task: "  fix the flush race  ",
    repository: "/srv/repo",
    checks: [{ name: "tests", argv: ["cargo", "test", "--locked"] }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.task, "fix the flush race");
  assert.equal(result.value.repository, "/srv/repo");
  assert.deepEqual(result.value.checks[0]?.argv, ["cargo", "test", "--locked"]);
});

test("proposal validation rejects ambiguous or dangerous input", () => {
  const cases = [
    { task: "", checks: [] },
    { task: "x", repository: "relative/path", checks: [] },
    { task: "x", checks: [{ name: "bad name", argv: ["cargo"] }] },
    { task: "x", checks: [{ name: "tests", argv: [] }] },
    { task: "x", checks: [{ name: "tests", argv: ["cargo test"] }] },
    { task: "x", checks: [{ name: "tests", argv: ["cargo", "a\0b"] }] },
    { task: "x", checks: [{ name: "tests", argv: ["cargo"] }, { name: "tests", argv: ["go"] }] },
    {
      task: "x",
      checks: ["a", "b", "c", "d", "e"].map((name) => ({ name, argv: ["true"] })),
    },
  ];
  for (const input of cases) {
    const result = validateProposalInput(input as never);
    assert.equal(result.ok, false, JSON.stringify(input));
  }
  const tooLong = validateProposalInput({ task: "x".repeat(4001), checks: [] });
  assert.equal(tooLong.ok, false);
});

test("checks are detected from manifests and never invented", () => {
  assert.deepEqual(
    detectChecks({ has: (name) => name === "Cargo.toml", read: () => undefined }),
    [{ name: "tests", argv: ["cargo", "test", "--locked"] }],
  );
  assert.deepEqual(
    detectChecks({
      has: (name) => name === "package.json",
      read: (name) => (name === "package.json" ? JSON.stringify({ scripts: { test: "vitest" } }) : undefined),
    }),
    [{ name: "tests", argv: ["npm", "test"] }],
  );
  assert.deepEqual(
    detectChecks({
      has: (name) => name === "package.json",
      read: () => JSON.stringify({ scripts: { build: "tsc" } }),
    }),
    [],
  );
  assert.deepEqual(
    detectChecks({
      has: (name) => name === "Makefile",
      read: (name) => (name === "Makefile" ? "build:\n\ttrue\ntest:\n\ttrue\n" : undefined),
    }),
    [{ name: "tests", argv: ["make", "test"] }],
  );
  assert.deepEqual(
    detectChecks({ has: (name) => name === "pyproject.toml", read: () => "" }),
    [{ name: "tests", argv: ["pytest"] }],
  );
  const many = detectChecks({
    has: () => true,
    read: (name) =>
      name === "package.json"
        ? JSON.stringify({ scripts: { test: "x" } })
        : name === "Makefile" || name === "justfile"
          ? "test:\n\ttrue\n"
          : "",
  });
  assert.equal(many.length, 2);
});

test("labels stay short and safe", () => {
  assert.equal(shortTask("a  b\n c"), "a b c");
  assert.equal(shortTask("x".repeat(80), 10), "xxxxxxxxx…");
  assert.equal(slug("Fix: the audit-log race!"), "fix-the-audit-log-race");
  assert.equal(slug("!!!"), "run");
});

test("the run brief carries the worktree, baseline and approval rules", () => {
  const brief = runBrief({
    sessionID: "ses_run",
    root: "ses_root",
    repository: "/repo",
    worktree: "/worktrees/run",
    baseline: "abc123",
    task: "fix the race",
    checks: [{ name: "tests", argv: ["cargo", "test"] }],
  });
  assert.match(brief, /RUN CONFIRMED/);
  assert.match(brief, /Worktree: \/worktrees\/run/);
  assert.match(brief, /Baseline: abc123/);
  assert.match(brief, /tests: cargo test/);
  assert.match(brief, /explicit approval/);
});
