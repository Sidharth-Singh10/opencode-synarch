import { Rpc } from "@opencode/plugin/rpc";

/**
 * Typed actions the TUI (or any other client) performs against the Synarch
 * server part. Reads come from session metadata so there is only one source of
 * truth; this RPC only changes things.
 */
export const SynarchRpc = Rpc.define({
  id: "synarch",
  methods: {
    approve: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          proposalID: { type: "string" },
        },
        required: ["sessionID", "proposalID"],
        additionalProperties: false,
      },
      errors: {
        failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      output: {
        type: "object",
        properties: {
          runSessionID: { type: "string" },
          worktree: { type: "string" },
          baseline: { type: "string" },
        },
        required: ["runSessionID", "worktree", "baseline"],
        additionalProperties: false,
      },
    },
    reject: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          proposalID: { type: "string" },
        },
        required: ["sessionID", "proposalID"],
        additionalProperties: false,
      },
      errors: {
        failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    interrupt: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      errors: {
        failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      output: {
        type: "object",
        properties: { interrupted: { type: "boolean" } },
        required: ["interrupted"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
        },
        required: ["sessionID", "kind"],
        additionalProperties: false,
      },
    },
  },
});

export type SynarchRpcType = typeof SynarchRpc;
