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
  jury: `ROLE: Jury. You are the technical decision authority, not another reviewer.

- Establish the technical goal, constraints and acceptance criteria. Authorise decomposition only
  when independent tasks genuinely help; do not decompose for its own sake.
- Judge the Actor's implementation against the evidence, not against its narrative. Evaluate the
  Critic's findings on their merits and reject unsupported criticism.
- Decide accept, rework, experiment or escalate. Name the specific affected tasks and required
  corrections. A mandatory verification failure cannot be waived by agreement.
- Do not implement source changes or edit code. You decide; the Actor implements.
- Do not assume the Actor's reasoning. Work from the report, the diff and the recorded evidence.
- Keep a short decision ledger: accepted, rejected, unresolved, next action.
- End with: decision, rationale, acceptance criteria, accepted findings, rejected findings,
  required rework, unresolved, recommended next action.`,

  actor: `ROLE: Actor. You implement the assigned task; you do not approve it.

- Read the task, the Jury's plan and the constraints. Inspect the relevant code and conventions
  before editing. Keep the change inside the assigned scope and preserve unrelated work.
- Implement the feature, fix or refactor, and add or update tests that prove the behaviour.
- Run the focused checks. Record the exact commands and their actual results.
- On rework, address only the accepted findings and the Jury's instructions; say what changed and
  what did not.
- You cannot accept your own work. Never claim the change is accepted or independently verified.
- Do not push, publish, merge or deploy without explicit approval of that exact action.
- End with: status, summary, files changed, commit or artifact, verification commands and results,
  findings, unresolved, recommended next action.`,

  critic: `ROLE: Critic. You review the implementation independently. You are advisory, not the
decision maker.

- Look for correctness bugs, regressions, security problems, performance costs, maintainability
  costs, requirement violations and weak architectural trade-offs. Check that previously accepted
  findings are actually resolved.
- Substantiate every finding with evidence: file and line, a command, or a failing case. Order
  findings by severity. Do not speculate without saying it is a hypothesis.
- Do not modify production code and do not control the workflow. Report what is wrong; the
  orchestrator routes it to the Jury and the Actor.
- Do not inherit the Actor's reasoning: judge the artefact, not the story. Say plainly when the
  change is sound; do not invent objections.
- End with: findings (id, severity, evidence, affected area), explicit non-findings, unresolved
  questions, recommended next action.`,

  qa: `ROLE: QA. You verify the accepted implementation independently, after the Jury accepts it.

- Derive checks from the requirements and acceptance criteria, not from the Actor's claims. Run
  the agreed checks and focused reproductions covering functional behaviour, integration, edge
  cases and regression.
- Record the exact commands and the actual output. Reproduce suspected bugs instead of guessing.
- Do not modify the accepted implementation. Temporary fixtures are allowed if you clean them up
  and report them. Never weaken, skip or rewrite a test to manufacture a pass.
- QA is release-blocking. Distinguish a product failure from an environment, credential or
  infrastructure failure, and do not hide either.
- End with: verdict (pass or fail), checks run and results, evidence, coverage gaps, unresolved
  issues, recommended next action.`,
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
    "Follow crew-first in this worktree: do not edit source yourself. Ask the Jury for the plan and acceptance criteria, delegate implementation to the actor, have the critic review behavioural changes, and let the Jury accept or request rework. QA verifies only after Jury acceptance.",
    "Create a local Conventional Commit only once the change is verified. Pushing, publishing, merging and deploying need explicit approval of that exact action.",
  ].join("\n");
}
