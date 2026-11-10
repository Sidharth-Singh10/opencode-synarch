import { For, Show, createEffect, createMemo } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { Context, SlotMap } from "@opencode/plugin/tui/context";

import {
  PLUGIN_ID,
  PLUGIN_KEY,
  PROPOSAL_KEY,
  ROLE_KEY,
  ROLE_LABELS,
  Role,
  RUN_KEY,
  RunRecord,
  shortTask,
} from "./protocol.js";
import type { Proposal } from "./protocol.js";
import { SynarchRpc } from "./rpc.js";
import { isSessionRunning } from "./status.js";

type SessionInfo = NonNullable<ReturnType<Context["data"]["session"]["get"]>>;

const PANEL = "synarch.panel";

function readObject<T>(session: SessionInfo | undefined, key: string): T | null {
  const value = session?.metadata?.[key];
  return value && typeof value === "object" ? (value as T) : null;
}

function readRun(session: SessionInfo | undefined): RunRecord | null {
  if (session?.metadata?.[PLUGIN_KEY] !== PLUGIN_ID) return null;
  return readObject<RunRecord>(session, RUN_KEY);
}

function family(ctx: Context, sessionID: string): string[] {
  try {
    const root = ctx.data.session.root(sessionID);
    return Array.from(new Set([root, ...ctx.data.session.family(root)]));
  } catch {
    return [sessionID];
  }
}

function isSynarch(ctx: Context, sessionID: string): boolean {
  return family(ctx, sessionID).some((id) => {
    const session = ctx.data.session.get(id);
    return (
      session?.agent === "synarch" ||
      session?.metadata?.[PLUGIN_KEY] === PLUGIN_ID ||
      Boolean(session?.metadata?.[ROLE_KEY])
    );
  });
}

function roleOf(session: SessionInfo | undefined): string {
  const role = session?.metadata?.[ROLE_KEY];
  if (typeof role === "string" && role in ROLE_LABELS) return ROLE_LABELS[role as Role];
  if (session?.metadata?.["synarch_kind"] === "run") return "Run";
  if (session?.agent === "synarch") return "Orchestrator";
  return session?.agent ?? "agent";
}

function toolLine(ctx: Context, sessionID: string): string {
  const messages = ctx.data.session.message.list(sessionID) ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type !== "assistant") continue;
    for (let part = message.content.length - 1; part >= 0; part -= 1) {
      const content = message.content[part];
      if (!content || content.type !== "tool") continue;
      if (content.state.status !== "running" && content.state.status !== "streaming") continue;
      const input = content.state.input;
      const value =
        typeof input === "string"
          ? input
          : (input.command ?? input.path ?? input.pattern ?? input.query ?? input.description ?? "");
      const text = String(value).replace(/\s+/g, " ").slice(0, 60);
      return text ? `${content.name} · ${text}` : content.name;
    }
  }
  return "";
}

function statusColor(ctx: Context, status: "idle" | "running") {
  return status === "running" ? ctx.theme.text.feedback.info.base : ctx.theme.text.faint;
}

function AgentRow(props: { ctx: Context; id: string }) {
  const session = () => props.ctx.data.session.get(props.id);
  const status = () => props.ctx.data.session.status(props.id);
  const running = () => isSessionRunning(session(), status());
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={statusColor(props.ctx, running() ? "running" : "idle")}>{running() ? "●" : "○"}</text>
        <text fg={props.ctx.theme.text.base}>{roleOf(session())}</text>
        <text fg={props.ctx.theme.text.faint}>{running() ? "running" : "idle"}</text>
      </box>
      <Show when={toolLine(props.ctx, props.id)}>
        <text fg={props.ctx.theme.text.muted}>  {toolLine(props.ctx, props.id)}</text>
      </Show>
    </box>
  );
}

function Sidebar(props: SlotMap["sidebar.content"]) {
  const ctx = usePlugin();
  const active = () => isSynarch(ctx, props.sessionID);
  const root = () => ctx.data.session.root(props.sessionID);
  const ids = () => family(ctx, props.sessionID);
  const proposal = () => readObject<Proposal>(ctx.data.session.get(root()), PROPOSAL_KEY);
  const session = () => ctx.data.session.get(root());
  const title = () => session()?.title ?? "Synarch";
  const directory = () => {
    const info = session();
    return info ? ctx.ui.format.path(info.location.directory) : "";
  };
  const branch = () => ctx.data.location.vcs.info()?.branch.current ?? "";
  const servers = () => ctx.data.location.mcp.server.list() ?? [];
  const online = () => servers().filter((server) => server.status.status !== "disabled").length;

  createEffect(() => {
    void ctx.data.location.vcs.sync();
    void ctx.data.location.mcp.server.sync();
    for (const id of ids()) {
      void ctx.data.session.sync(id);
      void ctx.data.session.message.sync(id);
    }
  });

  return (
    <Show when={active()}>
      <box flexDirection="column" gap={1} paddingTop={1}>
        <text fg={ctx.theme.text.base}>SYNARCH</text>
        <text fg={ctx.theme.text.muted}>{title()}</text>
        <text fg={ctx.theme.text.faint}>{directory()}{branch() ? ` · ${branch()}` : ""}</text>
        <For each={ids()}>{(id) => <AgentRow ctx={ctx} id={id} />}</For>
        <Show when={proposal()}>
          {(pending: () => Proposal) => (
            <box flexDirection="column">
              <text fg={ctx.theme.text.feedback.warning.base}>Proposal pending</text>
              <text fg={ctx.theme.text.muted}>{shortTask(pending().task, 44)}</text>
              <text fg={ctx.theme.text.faint}>/synarch to review</text>
            </box>
          )}
        </Show>
        <Show when={servers().length > 0}>
          <text fg={ctx.theme.text.faint}>MCP · {online()}/{servers().length} enabled</text>
        </Show>
      </box>
    </Show>
  );
}

function SynarchPanel(props: { panel: SlotMap["session.panel"] }) {
  const ctx = usePlugin();
  const root = () => ctx.data.session.root(props.panel.sessionID);
  const session = () => ctx.data.session.get(root());
  const proposal = createMemo(() => readObject<Proposal>(session(), PROPOSAL_KEY));
  const lastRunSession = () => {
    const id = session()?.metadata?.["synarch_last_run"];
    return typeof id === "string" ? ctx.data.session.get(id) : undefined;
  };
  const run = createMemo(() => readRun(lastRunSession()) ?? readRun(session()));
  const ids = createMemo(() => family(ctx, props.panel.sessionID));
  const directory = () => {
    const info = session();
    return info ? ctx.ui.format.path(info.location.directory) : "";
  };
  const rpc = () => ctx.client.rpc(SynarchRpc);

  createEffect(() => {
    for (const id of ids()) {
      void ctx.data.session.sync(id);
      void ctx.data.session.message.sync(id);
    }
  });

  const approve = async () => {
    const pending = proposal();
    if (!pending) return;
    try {
      const result = (await rpc().approve({ sessionID: root(), proposalID: pending.id })) as {
        runSessionID: string;
        worktree: string;
      };
      ctx.ui.toast.show({ message: `Isolated run started in ${result.worktree}`, variant: "success" });
      if (!ctx.ui.tabs.open(result.runSessionID)) {
        ctx.ui.toast.show({ message: `Run session ${result.runSessionID}`, variant: "info" });
      }
      void ctx.data.session.sync(root());
    } catch (error) {
      ctx.ui.toast.show({ message: errorMessage(error), variant: "error", duration: 8000 });
    }
  };

  const reject = async () => {
    const pending = proposal();
    if (!pending) return;
    try {
      await rpc().reject({ sessionID: root(), proposalID: pending.id });
      ctx.ui.toast.show({ message: "Proposal rejected", variant: "info" });
      void ctx.data.session.sync(root());
    } catch (error) {
      ctx.ui.toast.show({ message: errorMessage(error), variant: "error", duration: 8000 });
    }
  };

  const interrupt = async () => {
    const target = run()?.sessionID ?? props.panel.sessionID;
    try {
      const result = (await rpc().interrupt({ sessionID: target })) as { interrupted: boolean };
      ctx.ui.toast.show({
        message: result.interrupted ? "Interrupted" : "Nothing was running",
        variant: result.interrupted ? "warning" : "info",
      });
    } catch (error) {
      ctx.ui.toast.show({ message: errorMessage(error), variant: "error", duration: 8000 });
    }
  };

  ctx.keymap.layer(() => ({
    commands: [
      { id: "synarch.approve", title: "Approve isolated run", bind: "a", enabled: () => Boolean(proposal()), run: approve },
      { id: "synarch.reject", title: "Reject proposal", bind: "r", enabled: () => Boolean(proposal()), run: reject },
      { id: "synarch.interrupt", title: "Interrupt run", bind: "i", enabled: () => Boolean(run()), run: interrupt },
      { id: "synarch.close", title: "Close Synarch panel", bind: "escape", run: () => props.panel.close() },
    ],
  }));

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <box flexDirection="row" gap={1}>
        <text fg={ctx.theme.text.base}>SYNARCH</text>
        <text fg={ctx.theme.text.faint}>{directory()}</text>
      </box>

      <Show
        when={proposal()}
        fallback={<text fg={ctx.theme.text.muted}>No pending proposal. Ask the orchestrator to propose an isolated run.</text>}
      >
        {(pending: () => Proposal) => (
          <box flexDirection="column" gap={1} border borderColor={ctx.theme.border.base} padding={1}>
            <text fg={ctx.theme.text.feedback.warning.base}>Confirm isolated run</text>
            <text fg={ctx.theme.text.base}>{pending().task}</text>
            <text fg={ctx.theme.text.muted}>{pending().repository}</text>
            <text fg={ctx.theme.text.faint}>
              {pending().checks.length
                ? pending().checks.map((check: Proposal["checks"][number]) => `${check.name}: ${check.argv.join(" ")}`).join("   ")
                : "no mandatory check"}
            </text>
            <text fg={ctx.theme.text.muted}>[a] approve   [r] reject</text>
          </box>
        )}
      </Show>

      <Show when={run()}>
        {(active: () => RunRecord) => (
          <box flexDirection="column" gap={1}>
            <text fg={ctx.theme.text.base}>Run · {shortTask(active().task, 60)}</text>
            <text fg={ctx.theme.text.muted}>{ctx.ui.format.path(active().worktree)}</text>
            <text fg={ctx.theme.text.faint}>baseline {active().baseline.slice(0, 10)}   [i] interrupt</text>
          </box>
        )}
      </Show>

      <text fg={ctx.theme.text.base}>AGENTS</text>
      <For each={ids()}>{(id) => <AgentRow ctx={ctx} id={id} />}</For>
      <text fg={ctx.theme.text.faint}>[esc] close</text>
    </box>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

export default Plugin.define({
  id: "synarch.tui",
  setup(context) {
    const sidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <Sidebar {...input} />,
    });
    const panel = context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL}>
          <SynarchPanel panel={input} />
        </Show>
      ),
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "synarch.panel",
          title: "Synarch",
          description: "Review the pending run and live agents",
          group: "Synarch",
          palette: true,
          slash: { name: "synarch" },
          run: () => {
            if (!context.ui.panel.open(PANEL)) {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" });
            }
          },
        },
      ],
    }));

    const rpc = context.client.rpc(SynarchRpc);
    const unsubscribe = rpc.events.on("changed", (event) => {
      const data = event.data as { sessionID: string; kind: string };
      void context.data.session.sync(data.sessionID);
      if (data.kind === "proposed") {
        context.ui.toast.show({
          title: "Synarch",
          message: "Run proposed — /synarch to review",
          variant: "info",
          sessionID: data.sessionID,
        });
      }
      if (data.kind === "approved") {
        context.ui.toast.show({
          title: "Synarch",
          message: "Isolated run started",
          variant: "success",
          sessionID: data.sessionID,
        });
      }
    });

    return () => {
      unsubscribe();
      sidebar();
      panel();
    };
  },
});
