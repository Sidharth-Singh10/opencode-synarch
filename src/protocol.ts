/**
 * Shared Synarch vocabulary: roles, run records, proposal validation and check
 * detection. Everything here is pure so it can be tested without OpenCode.
 */

export const KIND_KEY = "synarch_kind";
export const PROPOSAL_KEY = "synarch_proposal";
export const RUN_KEY = "synarch_run";
export const ROLE_KEY = "synarch_role";
export const ROOT_KEY = "synarch_root";
export const PLUGIN_KEY = "synarch_plugin";
export const PLUGIN_ID = "opencode-synarch";

export type Role = "jury" | "actor" | "critic" | "qa";

export const ROLES: readonly Role[] = ["jury", "actor", "critic", "qa"];

export const ROLE_LABELS: Record<Role, string> = {
  jury: "Jury",
  actor: "Actor",
  critic: "Critic",
  qa: "QA",
};

/**
 * Role responsibilities. Workers use the same build configuration as the
 * orchestrator; these briefs are the only difference between them.
 */
export const ROLE_BRIEFS: Record<Role, string> = {
  jury: `ROLE: Jury. You investigate before anyone commits to a plan.

- Establish facts with the tools available: read the code, run read-only commands, inspect history, check documentation or upstream behaviour.
- Produce a concrete plan, the acceptance criteria you would verify against, and the risks you see. Cite files and commands.
- Do not take over implementation. If a fact requires an edit or a long build, describe the probe and hand it back.
- Say plainly what you could not establish and what evidence would settle it.
- Return a short assessment a colleague can act on immediately.`,

  actor: `ROLE: Actor. You implement the assigned change.

- Read the surrounding code first and follow its conventions, naming and error handling.
- Preserve unrelated and pre-existing work. Do not revert other people's edits.
- Keep the change scoped to the task. Add or update tests that prove the behaviour, then run the focused checks.
- Report exactly which files changed, which commands you ran, their results, and the risks that remain.
- Commit only when the task or the isolated run calls for it, using a Conventional Commit. Never push, publish, merge or deploy without explicit approval of that exact action.`,

  critic: `ROLE: Critic. You review the change independently.

- Look for correctness bugs, regressions, security problems, maintainability costs, and untested behaviour; reproduce a suspicion when you can instead of speculating.
- Ground every finding in evidence: file and line, a command, or a failing case. Order findings by severity.
- Do not silently rewrite the implementation. Review it, and coordinate if a fix is genuinely needed.
- Say clearly when the change is sound; do not invent objections to look thorough.
- Report what you did not review and why.`,

  qa: `ROLE: QA. You verify behaviour, not intentions.

- Run the agreed checks yourself and any focused reproduction the change needs. Record the exact commands and the actual output.
- Exercise the boundaries the change claims to affect. Report coverage gaps instead of assuming they are fine.
- Never weaken, skip or rewrite a test to manufacture a pass. Temporary fixtures are fine if you clean them up and say so.
- Distinguish a product failure from an environment or credential failure.
- Report failures plainly, with enough detail for the Actor to act on.`,
};

export interface Check {
  name: string;
  argv: string[];
}

export interface Proposal {
  id: string;
  sessionID: string;
  repository: string;
  task: string;
  checks: Check[];
  createdAt: number;
}

export interface RunRecord {
  sessionID: string;
  root: string;
  repository: string;
  worktree: string;
  baseline: string;
  task: string;
  checks: Check[];
  createdAt: number;
}

export interface ProposalInput {
  repository?: string;
  task: string;
  checks?: Check[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const COMMAND = /^[A-Za-z0-9_./@:+=-][A-Za-z0-9_./@:+=-]*$/;
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateProposalInput(input: ProposalInput): Validated<Omit<Proposal, "id" | "sessionID" | "createdAt">> {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) return { ok: false, error: "task must not be empty" };
  if (task.length > 4000) return { ok: false, error: "task must be at most 4000 characters" };
  if (task.includes("\0")) return { ok: false, error: "task contains a NUL byte" };

  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  if (repository && (!repository.startsWith("/") || repository.includes("\0"))) {
    return { ok: false, error: "repository must be an absolute path" };
  }

  const raw = input.checks ?? [];
  if (!Array.isArray(raw)) return { ok: false, error: "checks must be an array" };
  if (raw.length > 4) return { ok: false, error: "at most four checks are allowed" };
  const checks: Check[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "each check must be an object" };
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!CHECK_NAME.test(name)) return { ok: false, error: `invalid check name: ${JSON.stringify(name)}` };
    if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
      return { ok: false, error: `check ${name} needs a non-empty argv array` };
    }
    const argv = entry.argv.map((part) => (typeof part === "string" ? part : ""));
    if (argv.some((part) => !part || part.includes("\0"))) {
      return { ok: false, error: `check ${name} has an empty or invalid argument` };
    }
    if (!COMMAND.test(argv[0]!)) return { ok: false, error: `check ${name} has an invalid executable` };
    if (argv.join(" ").length > 4096) return { ok: false, error: `check ${name} is too long` };
    if (checks.some((check) => check.name === name)) {
      return { ok: false, error: `duplicate check name: ${name}` };
    }
    checks.push({ name, argv });
  }
  return { ok: true, value: { repository, task, checks } };
}

export interface ManifestSource {
  has(name: string): boolean;
  read(name: string): string | undefined;
}

/** Suggest repeatable project checks from manifests. Never executes anything. */
export function detectChecks(source: ManifestSource): Check[] {
  const checks: Check[] = [];
  if (source.has("package.json")) {
    const text = source.read("package.json");
    try {
      const parsed = text ? (JSON.parse(text) as { scripts?: Record<string, string> }) : {};
      if (parsed.scripts?.test) checks.push({ name: "tests", argv: ["npm", "test"] });
    } catch {
      // An unreadable manifest is not a reason to invent a command.
    }
  }
  if (source.has("Cargo.toml")) checks.push({ name: "tests", argv: ["cargo", "test", "--locked"] });
  if (source.has("go.mod")) checks.push({ name: "tests", argv: ["go", "test", "./..."] });
  const makefile = source.read("Makefile");
  if (makefile && /^test:/m.test(makefile)) checks.push({ name: "tests", argv: ["make", "test"] });
  const justfile = source.read("justfile");
  if (justfile && /^test:/m.test(justfile)) checks.push({ name: "tests", argv: ["just", "test"] });
  if (source.has("pyproject.toml")) checks.push({ name: "tests", argv: ["pytest"] });
  return checks.slice(0, 2);
}

export function shortTask(task: string, limit = 56): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

export function slug(value: string, limit = 32): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "run").slice(0, limit).replace(/-+$/g, "");
}

export function runBrief(run: Omit<RunRecord, "createdAt">): string {
  const checks = run.checks.length
    ? run.checks.map((check) => `- ${check.name}: ${check.argv.join(" ")}`).join("\n")
    : "- none agreed; choose a real, repeatable check or report why none exists";
  return [
    "RUN CONFIRMED. This session is an isolated Synarch run.",
    `Repository: ${run.repository}`,
    `Worktree: ${run.worktree}`,
    `Baseline: ${run.baseline}`,
    `Task: ${run.task}`,
    "Agreed checks:",
    checks,
    "",
    "Work in this worktree, never the original checkout. Use synarch_delegate with role jury, actor, critic or qa when independent work helps; workers run your build configuration and receive the role brief. Handle small work directly.",
    "Create a local Conventional Commit only once the change is verified. Pushing, publishing, merging and deploying need explicit approval of that exact action.",
  ].join("\n");
}
