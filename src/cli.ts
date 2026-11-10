#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlink, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- Managed by opencode-synarch. -->";

function agentSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "agents", "synarch.md"), "utf8");
}

function globalConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() ? xdg : join(homedir(), ".config");
}

function target(project: boolean): string {
  return project
    ? join(process.cwd(), ".opencode", "agents", "synarch.md")
    : join(globalConfigRoot(), "opencode", "agents", "synarch.md");
}

function check(path: string): "missing" | "managed" | "foreign" {
  if (!existsSync(path)) return "missing";
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return "foreign";
    return readFileSync(path, "utf8").includes(MARKER) ? "managed" : "foreign";
  } catch {
    return "foreign";
  }
}

function install(project: boolean): number {
  const path = target(project);
  const state = check(path);
  if (state === "foreign") {
    console.error(`refusing to overwrite ${path}: it exists and is not managed by opencode-synarch`);
    return 1;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${agentSource()}\n${MARKER}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`installed ${path}`);
  console.log("");
  console.log("Add the plugin to your OpenCode configuration:");
  console.log("");
  console.log("  {");
  console.log('    "$schema": "https://opencode.ai/config.json",');
  console.log('    "plugins": [{ "package": "opencode-synarch" }]');
  console.log("  }");
  console.log("");
  console.log("For a local checkout, use the absolute path as the package instead.");
  console.log("Then run /reload and select the synarch agent with /agents.");
  return 0;
}

function verify(project: boolean): number {
  const path = target(project);
  const state = check(path);
  console.log(`${path}: ${state}`);
  if (state === "managed") {
    console.log("run /agents in OpenCode and select synarch");
    return 0;
  }
  return 1;
}

function uninstall(project: boolean): number {
  const path = target(project);
  const state = check(path);
  if (state === "missing") {
    console.log(`nothing to remove at ${path}`);
    return 0;
  }
  if (state === "foreign") {
    console.error(`refusing to remove ${path}: it is not managed by opencode-synarch`);
    return 1;
  }
  rmSync(path);
  console.log(`removed ${path}`);
  return 0;
}

function main(argv: string[]): number {
  const command = argv[0] ?? "install";
  const project = argv.includes("--project");
  const unknown = argv.filter((arg) => !["install", "check", "uninstall", "--project", "--global"].includes(arg));
  if (unknown.length) {
    console.error(`unknown argument: ${unknown[0]}`);
    return 2;
  }
  switch (command) {
    case "install":
      return install(project);
    case "check":
      return verify(project);
    case "uninstall":
      return uninstall(project);
    default:
      console.error(`unknown command: ${command}`);
      console.error("usage: opencode-synarch <install|check|uninstall> [--project|--global]");
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
