import {
  Check,
  KIND_KEY,
  PROPOSAL_KEY,
  Proposal,
  ProposalInput,
  ROLE_BRIEFS,
  ROLE_KEY,
  ROLE_LABELS,
  ROLES,
  ROOT_KEY,
  RUN_KEY,
  Role,
  RunRecord,
  detectChecks,
  runBrief,
  shortTask,
  slug,
  validateProposalInput,
} from "./protocol.js";

export interface SessionInfoLike {
  id: string;
  parentID?: string | null;
  projectID: string;
  agent?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  location: { directory: string };
}

export interface SessionCreateLike {
  parentID?: string;
  title?: string;
  agent?: string;
  location?: { directory: string };
  metadata?: Record<string, unknown>;
}

export interface Host {
  /** Directory of the plugin instance that owns this service. */
  directory(): string;
  /** Agent used for worker sessions. Defaults to the built-in build agent. */
  workerAgent(): string;
  /** Run a read-only git command in a directory and return trimmed stdout. */
  git(directory: string, args: string[]): Promise<string>;
  /** Read manifests and suggest checks. Never executes project code. */
  suggestChecks(directory: string): Promise<Check[]>;
  now(): number;
  newID(): string;
  session: {
    get(id: string): Promise<SessionInfoLike>;
    create(input: SessionCreateLike): Promise<SessionInfoLike>;
    update(input: { sessionID: string; metadata: Record<string, unknown> }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<unknown>;
    interrupt(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
  };
  worktree: {
    create(input: { projectID: string; name: string }): Promise<{ directory: string }>;
  };
}

export interface DelegateInput {
  role: Role;
  task: string;
  background?: boolean;
}

export interface DelegateResult {
  sessionID: string;
  role: Role;
  agent: string;
  status: "running" | "idle";
  reply: string;
}

export interface ApproveResult {
  runSessionID: string;
  worktree: string;
  baseline: string;
}

export interface SynarchState {
  sessionID: string;
  directory: string;
  proposal: Proposal | null;
  run: RunRecord | null;
  lastRun: string | null;
}

type Emit = (event: { sessionID: string; kind: string }) => Promise<void> | void;

const MAX_TASK = 4000;

/**
 * Orchestration logic, independent of OpenCode. The plugin adapter supplies
 * sessions, worktrees and git; tests supply fakes.
 */
export class SynarchService {
  private readonly proposals = new Map<string, Proposal>();
  private readonly approving = new Set<string>();

  constructor(
    private readonly host: Host,
    private readonly emit: Emit = () => {},
  ) {}

  async state(sessionID: string): Promise<SynarchState> {
    const session = await this.host.session.get(sessionID);
    return {
      sessionID,
      directory: session.location.directory,
      proposal: this.readProposal(session, sessionID),
      run: this.readRun(session),
      lastRun: typeof session.metadata?.["synarch_last_run"] === "string"
        ? (session.metadata["synarch_last_run"] as string)
        : null,
    };
  }

  async propose(sessionID: string, input: ProposalInput): Promise<Proposal> {
    const validated = validateProposalInput(input);
    if (!validated.ok) throw new Error(validated.error);
    const session = await this.host.session.get(sessionID);
    const directory = session.location.directory;

    let repository: string;
    try {
      repository = await this.host.git(directory, ["rev-parse", "--show-toplevel"]);
    } catch {
      throw new Error("isolated runs require a Git repository in this workspace");
    }
    if (validated.value.repository && validated.value.repository !== repository) {
      throw new Error(
        `the proposal repository must be this workspace's repository (${repository})`,
      );
    }

    const status = await this.host.git(repository, ["status", "--porcelain"]);
    if (status) {
      throw new Error(
        "the repository has uncommitted changes; commit or stash them before proposing an isolated run",
      );
    }

    const checks = validated.value.checks.length
      ? validated.value.checks
      : await this.host.suggestChecks(repository);

    const proposal: Proposal = {
      id: this.host.newID(),
      sessionID,
      repository,
      task: validated.value.task,
      checks,
      createdAt: this.host.now(),
    };
    this.proposals.set(sessionID, proposal);
    await this.host.session.update({
      sessionID,
      metadata: this.patch(session, { [PROPOSAL_KEY]: proposal }),
    });
    await this.emit({ sessionID, kind: "proposed" });
    return proposal;
  }

  async reject(sessionID: string, proposalID: string): Promise<void> {
    const session = await this.host.session.get(sessionID);
    const proposal = this.readProposal(session, sessionID);
    if (!proposal || proposal.id !== proposalID) {
      throw new Error("that proposal is no longer pending");
    }
    this.proposals.delete(sessionID);
    await this.host.session.update({
      sessionID,
      metadata: this.patch(session, { [PROPOSAL_KEY]: null }),
    });
    await this.emit({ sessionID, kind: "rejected" });
  }

  async approve(sessionID: string, proposalID: string): Promise<ApproveResult> {
    if (this.approving.has(sessionID)) {
      throw new Error("that proposal is already starting; wait for the run session");
    }
    this.approving.add(sessionID);
    try {
      return await this.start(sessionID, proposalID);
    } finally {
      this.approving.delete(sessionID);
    }
  }

  private async start(sessionID: string, proposalID: string): Promise<ApproveResult> {
    const session = await this.host.session.get(sessionID);
    const proposal = this.readProposal(session, sessionID);
    if (!proposal || proposal.id !== proposalID) {
      throw new Error("that proposal is no longer pending; ask the orchestrator to propose again");
    }

    let repository: string;
    try {
      repository = await this.host.git(session.location.directory, ["rev-parse", "--show-toplevel"]);
    } catch {
      throw new Error("the workspace is no longer a Git repository");
    }
    if (repository !== proposal.repository) {
      throw new Error("the workspace repository changed since the proposal was made");
    }
    const status = await this.host.git(repository, ["status", "--porcelain"]);
    if (status) {
      throw new Error("the repository is no longer clean; commit or stash changes before starting");
    }
    const baseline = await this.host.git(repository, ["rev-parse", "HEAD"]);

    const worktree = await this.host.worktree.create({
      projectID: session.projectID,
      name: `synarch-${slug(proposal.task)}`,
    });

    const record: RunRecord = {
      sessionID: "",
      root: sessionID,
      repository,
      worktree: worktree.directory,
      baseline,
      task: proposal.task,
      checks: proposal.checks,
      createdAt: this.host.now(),
    };
    const runSession = await this.host.session.create({
      parentID: sessionID,
      agent: "synarch",
      title: `Synarch run · ${shortTask(proposal.task)}`,
      location: { directory: worktree.directory },
      metadata: {
        [KIND_KEY]: "run",
        [ROOT_KEY]: sessionID,
        [RUN_KEY]: { ...record, sessionID: "pending" },
      },
    });
    const finished: RunRecord = { ...record, sessionID: runSession.id };
    await this.host.session.update({
      sessionID: runSession.id,
      metadata: this.patch(runSession, { [RUN_KEY]: finished }),
    });
    await this.host.session.prompt({ sessionID: runSession.id, text: runBrief(finished) });
    await this.host.session.update({
      sessionID,
      metadata: this.patch(session, {
        [PROPOSAL_KEY]: null,
        synarch_last_run: runSession.id,
      }),
    });
    this.proposals.delete(sessionID);
    await this.emit({ sessionID, kind: "approved" });
    return { runSessionID: runSession.id, worktree: worktree.directory, baseline };
  }

  async delegate(sessionID: string, input: DelegateInput): Promise<DelegateResult> {
    const role = input.role;
    if (!ROLES.includes(role)) throw new Error(`unknown role: ${String(role)}`);
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) throw new Error("task must not be empty");
    if (task.length > MAX_TASK) throw new Error(`task must be at most ${MAX_TASK} characters`);

    const session = await this.host.session.get(sessionID);
    const root = await this.rootOf(session);
    const agent = this.host.workerAgent();
    const child = await this.host.session.create({
      parentID: sessionID,
      agent,
      title: `${ROLE_LABELS[role]} · ${shortTask(task, 48)}`,
      metadata: { [KIND_KEY]: "worker", [ROLE_KEY]: role, [ROOT_KEY]: root },
    });
    await this.host.session.prompt({
      sessionID: child.id,
      text: `${ROLE_BRIEFS[role]}\n\nTASK\n${task}`,
    });

    if (input.background) {
      return { sessionID: child.id, role, agent, status: "running", reply: "" };
    }

    await this.host.session.wait({ sessionID: child.id });
    const reply = extractReply(await this.host.session.context({ sessionID: child.id }));
    return {
      sessionID: child.id,
      role,
      agent,
      status: "idle",
      reply: reply || "(the worker produced no final text; open its session for the details)",
    };
  }

  async interrupt(sessionID: string): Promise<boolean> {
    const result = (await this.host.session.interrupt({ sessionID })) as
      | { interrupted?: boolean }
      | undefined;
    const interrupted = result?.interrupted !== false;
    if (interrupted) await this.emit({ sessionID, kind: "interrupted" });
    return interrupted;
  }

  private async rootOf(session: SessionInfoLike): Promise<string> {
    let current = session;
    const seen = new Set<string>([session.id]);
    while (current.parentID) {
      if (seen.has(current.parentID)) break;
      seen.add(current.parentID);
      current = await this.host.session.get(current.parentID);
    }
    return current.id;
  }

  private patch(session: SessionInfoLike, patch: Record<string, unknown>): Record<string, unknown> {
    return { ...(session.metadata ?? {}), ...patch };
  }

  private readProposal(session: SessionInfoLike, sessionID: string): Proposal | null {
    const cached = this.proposals.get(sessionID);
    if (cached) return cached;
    const value = session.metadata?.[PROPOSAL_KEY];
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<Proposal>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.repository !== "string" ||
      typeof raw.task !== "string" ||
      !Array.isArray(raw.checks) ||
      raw.sessionID !== sessionID
    ) {
      return null;
    }
    const proposal: Proposal = {
      id: raw.id,
      sessionID,
      repository: raw.repository,
      task: raw.task,
      checks: raw.checks as Check[],
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    };
    this.proposals.set(sessionID, proposal);
    return proposal;
  }

  private readRun(session: SessionInfoLike): RunRecord | null {
    const value = session.metadata?.[RUN_KEY];
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<RunRecord>;
    if (
      typeof raw.worktree !== "string" ||
      typeof raw.repository !== "string" ||
      typeof raw.baseline !== "string" ||
      typeof raw.task !== "string"
    ) {
      return null;
    }
    return {
      sessionID: typeof raw.sessionID === "string" ? raw.sessionID : session.id,
      root: typeof raw.root === "string" ? raw.root : session.id,
      repository: raw.repository,
      worktree: raw.worktree,
      baseline: raw.baseline,
      task: raw.task,
      checks: Array.isArray(raw.checks) ? (raw.checks as Check[]) : [],
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    };
  }
}

/** Extract the last assistant text from an OpenCode session context payload. */
export function extractReply(payload: unknown): string {
  const messages: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { messages?: unknown[] }).messages)
      ? ((payload as { messages?: unknown[] }).messages as unknown[])
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if ((message as { type?: string }).type !== "assistant") continue;
    const content = (message as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part): part is { type: string; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Only used by tests to keep the manifest detector honest. */
export function detectFromFiles(files: Record<string, string>): Check[] {
  return detectChecks({
    has: (name) => name in files,
    read: (name) => files[name],
  });
}
