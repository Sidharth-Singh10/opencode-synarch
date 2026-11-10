export interface SessionTimes {
  time?: {
    busy?: number;
    idle?: number;
  };
}

/**
 * The TUI's live status is authoritative when it says running, but it can lag
 * behind (or stay idle) for a session that is executing. A session is also
 * running while its last busy timestamp is newer than its last idle timestamp.
 */
export function isSessionRunning(
  info: SessionTimes | undefined,
  live: "idle" | "running",
): boolean {
  if (live === "running") return true;
  const busy = info?.time?.busy ?? 0;
  const idle = info?.time?.idle ?? 0;
  return busy > idle;
}
