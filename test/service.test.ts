import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "../src/protocol.js";
import { Host, SessionCreateLike, SessionInfoLike, SynarchService, extractReply } from "../src/service.js";

class FakeHost implements Host {
  readonly sessions = new Map<string, SessionInfoLike>();
  readonly creates: SessionCreateLike[] = [];
  readonly prompts: { sessionID: string; text: string }[] = [];
  readonly updates: { sessionID: string; metadata: Record<string, unknown> }[] = [];
  readonly waits: string[] = [];
  readonly interrupted: string[] = [];
  readonly trees: { projectID: string; name: string }[] = [];
  readonly gitCalls: { directory: string; args: string[] }[] = [];
  readonly gitResults = new Map<string, string>();
  checks: Check[] = [];
  reply = "worker reply";
  events: string[] = [];
  private sequence = 0;
  private clock = 1_000;

  constructor(readonly root = "/repo") {
    this.add({
      id: "ses_root",
      projectID: "proj",
      agent: "synarch",
      title: "Synarch",
      location: { directory: root },
      metadata: {},
    });
    this.gitResults.set(`${root}|rev-parse --show-toplevel`, root);
    this.gitResults.set(`${root}|status --porcelain`, "");
    this.gitResults.set(`${root}|rev-parse HEAD`, "0123456789abcdef0123456789abcdef01234567");
  }

  add(session: SessionInfoLike): SessionInfoLike {
    this.sessions.set(session.id, session);
    return session;
  }

  directory(): string {
    return this.root;
  }

  workerAgent(): string {
    return "build";
  }

  async git(directory: string, args: string[]): Promise<string> {
    this.gitCalls.push({ directory, args });
    const key = `${directory}|${args.join(" ")}`;
    const value = this.gitResults.get(key);
    if (value === undefined) throw new Error(`git ${args.join(" ")} failed`);
    return value;
  }

  async suggestChecks(): Promise<Check[]> {
    return this.checks;
  }

  now(): number {
    return this.clock++;
  }

  newID(): string {
    return `id-${++this.sequence}`;
  }

  session = {
    get: async (id: string): Promise<SessionInfoLike> => {
      const session = this.sessions.get(id);
      if (!session) throw new Error(`missing session ${id}`);
      return session;
    },
    create: async (input: SessionCreateLike): Promise<SessionInfoLike> => {
      this.creates.push(input);
      const session: SessionInfoLike = {
        id: `ses_${this.creates.length}`,
        parentID: input.parentID ?? null,
        projectID: "proj",
        agent: input.agent ?? null,
        title: input.title ?? null,
        metadata: input.metadata ?? {},
        location: input.location ?? { directory: this.root },
      };
      this.sessions.set(session.id, session);
      return session;
    },
    update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }): Promise<void> => {
      this.updates.push({ sessionID, metadata });
      const session = this.sessions.get(sessionID);
      if (!session) throw new Error(`missing session ${sessionID}`);
      session.metadata = { ...(session.metadata ?? {}), ...metadata };
    },
    prompt: async ({ sessionID, text }: { sessionID: string; text: string }): Promise<void> => {
      this.prompts.push({ sessionID, text });
    },
    wait: async ({ sessionID }: { sessionID: string }): Promise<void> => {
      this.waits.push(sessionID);
    },
    interrupt: async ({ sessionID }: { sessionID: string }): Promise<{ interrupted: boolean }> => {
      this.interrupted.push(sessionID);
      return { interrupted: true };
    },
    context: async (): Promise<unknown> => [
      {
        type: "assistant",
        content: [
          { type: "text", text: this.reply },
          { type: "tool", name: "shell" },
        ],
      },
    ],
  };

  worktree = {
    create: async ({ projectID, name }: { projectID: string; name: string }) => {
      this.trees.push({ projectID, name });
      return { directory: `/worktrees/${name}` };
    },
  };
}

function makeService(host: FakeHost): { service: SynarchService; events: string[] } {
  const events: string[] = [];
  host.events = events;
  return {
    service: new SynarchService(host, (event) => {
      events.push(event.kind);
    }),
    events,
  };
}

async function proposed(host: FakeHost): Promise<{ service: SynarchService; id: string; events: string[] }> {
  const built = makeService(host);
  const proposal = await built.service.propose("ses_root", {
    task: "fix the flush race",
    checks: [{ name: "tests", argv: ["cargo", "test"] }],
  });
  return { ...built, id: proposal.id };
}

test("a proposal is stored on the session and announced without side effects", async () => {
  const host = new FakeHost();
  host.checks = [{ name: "tests", argv: ["cargo", "test", "--locked"] }];
  const { service, events } = await proposed(host).then((value) => value);
  const state = await service.state("ses_root");
  assert.equal(state.proposal?.task, "fix the flush race");
  assert.equal(state.proposal?.repository, "/repo");
  assert.equal(host.creates.length, 0);
  assert.equal(host.trees.length, 0);
  assert.deepEqual(events, ["proposed"]);
});

test("a dirty or non-Git workspace cannot be proposed", async () => {
  const dirty = new FakeHost();
  dirty.gitResults.set("/repo|status --porcelain", " M src/lib.rs");
  const { service } = makeService(dirty);
  await assert.rejects(
    service.propose("ses_root", { task: "x", checks: [] }),
    /uncommitted changes/,
  );
  assert.equal(dirty.updates.length, 0);

  const absent = new FakeHost();
  absent.gitResults.delete("/repo|rev-parse --show-toplevel");
  await assert.rejects(makeService(absent).service.propose("ses_root", { task: "x", checks: [] }), /Git repository/);

  const mismatch = new FakeHost();
  await assert.rejects(
    makeService(mismatch).service.propose("ses_root", { task: "x", repository: "/other", checks: [] }),
    /must be this workspace/,
  );
});

test("approval creates a worktree, a Synarch run session and a handoff", async () => {
  const host = new FakeHost();
  const { service, id, events } = await proposed(host);
  const result = await service.approve("ses_root", id);

  assert.deepEqual(host.trees, [{ projectID: "proj", name: "synarch-fix-the-flush-race" }]);
  const created = host.creates[0]!;
  assert.equal(created.agent, "synarch");
  assert.equal(created.parentID, "ses_root");
  assert.equal(created.location?.directory, result.worktree);
  assert.equal(created.metadata?.synarch_kind, "run");
  assert.equal(created.metadata?.synarch_root, "ses_root");

  const prompt = host.prompts.find((entry) => entry.sessionID === result.runSessionID);
  assert.match(prompt?.text ?? "", /RUN CONFIRMED/);
  assert.match(prompt?.text ?? "", /fix the flush race/);

  const root = await service.state("ses_root");
  assert.equal(root.proposal, null);
  assert.equal(root.lastRun, result.runSessionID);
  assert.deepEqual(events, ["proposed", "approved"]);

  await assert.rejects(service.approve("ses_root", id), /no longer pending/);
});

test("approval re-checks the working tree and rejects a stale proposal", async () => {
  const host = new FakeHost();
  const { service, id } = await proposed(host);
  host.gitResults.set("/repo|status --porcelain", " M later.rs");
  await assert.rejects(service.approve("ses_root", id), /no longer clean/);
  assert.equal(host.trees.length, 0);

  const other = new FakeHost();
  const second = await proposed(other);
  await assert.rejects(second.service.approve("ses_root", "wrong"), /no longer pending/);
});

test("rejection clears the proposal", async () => {
  const host = new FakeHost();
  const { service, id, events } = await proposed(host);
  await service.reject("ses_root", id);
  const state = await service.state("ses_root");
  assert.equal(state.proposal, null);
  assert.deepEqual(events, ["proposed", "rejected"]);
  await assert.rejects(service.reject("ses_root", id), /no longer pending/);
});

test("delegation creates a build-capable child with the role brief", async () => {
  const host = new FakeHost();
  const { service } = makeService(host);
  const result = await service.delegate("ses_root", { role: "jury", task: "map the flush path" });

  const created = host.creates[0]!;
  assert.equal(created.agent, "build");
  assert.equal(created.parentID, "ses_root");
  assert.equal(created.metadata?.synarch_role, "jury");
  assert.match(String(created.title), /^Jury · map the flush path/);

  const prompt = host.prompts[0]!;
  assert.match(prompt.text, /ROLE: Jury/);
  assert.match(prompt.text, /TASK\nmap the flush path/);
  assert.deepEqual(host.waits, [result.sessionID]);
  assert.equal(result.status, "idle");
  assert.equal(result.reply, "worker reply");
});

test("background delegation returns without waiting", async () => {
  const host = new FakeHost();
  const { service } = makeService(host);
  const result = await service.delegate("ses_root", {
    role: "qa",
    task: "verify the fix",
    background: true,
  });
  assert.deepEqual(host.waits, []);
  assert.equal(result.status, "running");
  assert.equal(result.reply, "");
});

test("invalid delegation is refused", async () => {
  const host = new FakeHost();
  const { service } = makeService(host);
  await assert.rejects(service.delegate("ses_root", { role: "boss" as never, task: "x" }), /unknown role/);
  await assert.rejects(service.delegate("ses_root", { role: "actor", task: "  " }), /must not be empty/);
  assert.equal(host.creates.length, 0);
});

test("state survives a service restart through session metadata", async () => {
  const host = new FakeHost();
  const { id } = await proposed(host);
  const restarted = new SynarchService(host);
  const state = await restarted.state("ses_root");
  assert.equal(state.proposal?.id, id);
});

test("interrupt is reported and announced", async () => {
  const host = new FakeHost();
  const { service, events } = makeService(host);
  assert.equal(await service.interrupt("ses_root"), true);
  assert.deepEqual(host.interrupted, ["ses_root"]);
  assert.deepEqual(events, ["interrupted"]);
});

test("reply extraction only uses the last assistant text", () => {
  assert.equal(extractReply([{ type: "assistant", content: [{ type: "text", text: "done" }] }]), "done");
  assert.equal(extractReply({ messages: [{ type: "assistant", content: [{ type: "text", text: "nested" }] }] }), "nested");
  assert.equal(extractReply([{ type: "user", content: [{ type: "text", text: "no" }] }]), "");
  assert.equal(extractReply(undefined), "");
});
