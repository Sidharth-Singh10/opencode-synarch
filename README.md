# opencode-synarch

Synarch as an OpenCode plugin: one orchestrator agent, build-capable workers, and
live agent activity in the OpenCode TUI.

This replaces Synarch's separate browser console. The Synarch Rust CLI and its
evidence-gated controller remain a separate product; this package is the
interactive surface inside OpenCode.

## What it adds

- A `synarch` primary agent you select with `/agents`.
- `synarch_delegate`: work is handed to a child session running the built-in
  `build` agent. Jury, Actor, Critic and QA are instruction profiles, not
  restricted tool sets.
- `synarch_propose`: an isolated worktree run. It validates the repository, task
  and checks, stores a pending proposal, and creates nothing until you approve it
  in `/synarch`.
- A sidebar block that shows the current Synarch session, its workspace, branch,
  enabled MCP count, and every worker with its live tool.
- A `/synarch` panel with the pending proposal, the current run, approve/reject
  and interrupt keys, and the agent list.

All Synarch agents run with your normal build configuration: your model, MCP
servers, permissions and instructions. Roles differ only in the brief the plugin
attaches to each worker.

## Requirements

- OpenCode 2.2.7 or newer (the plugin API is V2).
- A Git repository and a committed working tree for isolated runs. Direct work
  and delegation do not need a clean tree.

## Install

Until this is published, load it from a checkout:

```sh
git clone <this repository> opencode-synarch
cd opencode-synarch
npm install
npm run build
node dist/src/cli.js install
```

`install` writes a managed `synarch.md` agent file to
`~/.config/opencode/agents/` (or `$XDG_CONFIG_HOME`). It refuses to overwrite a
file it does not own; `--project` writes to `./.opencode/agents/` instead.
`check` and `uninstall` are available too.

Add the plugin to your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-synarch"]
}
```

For a published package, use `{ "package": "opencode-synarch" }`. Put the entry in
the global `~/.config/opencode/opencode.json(c)` to use it in every project, or in
a project's `opencode.json(c)` to use it there only.

Then run `/reload`, open `/agents`, and select **synarch**.

## Use

```text
Fix the failing test in this module and run the focused check.
```

Small tasks are handled directly. For larger work the orchestrator delegates:

```text
Use the jury to map how the flush path works, then have the actor implement the
lock ordering fix and the qa verify it under concurrency.
```

For isolation:

```text
This change touches too much for the current checkout. Propose an isolated run
with the project checks, and wait for my approval.
```

Open `/synarch` to review the proposal. `a` approves, `r` rejects, `i`
interrupts the run, `esc` closes. Approval creates an OpenCode worktree and a new
Synarch session there, then hands it the task, baseline and checks.

## How it works

- The server part registers the tools, a context hook for `synarch` sessions, and
  a small RPC (`approve`, `reject`, `interrupt`).
- Proposals and run records live in session metadata, so the TUI, other clients
  and a later process all read the same state.
- Workers are child sessions with `agent: "build"`, the parent's selected model,
  a `synarch_role` metadata entry, and a role brief prepended to the task.
- Isolated runs use OpenCode's own worktree support and a fresh `synarch`
  session moved into that worktree, so shell commands and edits run there, not
  just "as instructed". The native session tree and tabs show the run too.

## Limits

- Roles are instructions, not a security boundary. Every worker can edit files
  and run commands.
- Direct work changes the checkout immediately and spends provider allowance.
  Only isolated-run creation is gated by the approval panel.
- There is no sandbox beyond what OpenCode and your OS provide. A worktree
  shares Git metadata and your account.
- If the OpenCode server restarts between proposing and approving, the proposal
  is gone; ask the orchestrator to propose again.
- `build` must be available as an agent (it is a built-in). Override the worker
  agent with the plugin option `workerAgent` if you have a better one.

## Development

```sh
npm install
npm run typecheck
npm test          # builds and runs the server/service tests with node:test
```

Load the checkout directly while developing:

```jsonc
{
  "plugins": [{ "package": "/absolute/path/to/opencode-synarch" }]
}
```

The server and service layers are tested without a model. The TUI is verified by
loading the plugin in a real OpenCode session.
