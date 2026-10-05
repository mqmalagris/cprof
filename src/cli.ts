#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  addProfile,
  type Config,
  configPathFor,
  editProfileMcp,
  envFor,
  expandHome,
  initialConfig,
  loadConfig,
  pathKey,
  type Profile,
  removeProfile,
  renameProfile,
  resolveProfiles,
  saveConfig,
} from "./config";
import {
  apply,
  describe,
  knownServers,
  type McpRunner,
  missingShared,
  plan,
  type PlanOptions,
  readClaudeJson,
  readUserMcp,
} from "./setup";

const home = homedir();
const configPath = configPathFor(home, process.env);

class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

function claudeBin() {
  const bin = process.env.CPROF_CLAUDE ?? Bun.which("claude");
  if (!bin) throw new CliError("claude is not on PATH (or set CPROF_CLAUDE to its path)");
  // Windows refuses to spawn .cmd/.bat without a shell, and a shell would re-parse the MCP JSON args.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin))
    throw new CliError(`${bin} is a .cmd shim, which cprof cannot start; install the native claude.exe or set CPROF_CLAUDE to it`);
  return bin;
}

function runClaude(profile: Profile, args: string[]) {
  const r = spawnSync(claudeBin(), args, { env: envFor(profile, process.env), stdio: "inherit" });
  if (r.error) throw new CliError(`could not start claude for ${profile.name}: ${r.error.message}`);
  return r.status ?? 1;
}

const runMcp: McpRunner = (profile, args) => {
  const status = runClaude(profile, args);
  if (status !== 0) throw new CliError(`claude ${args.slice(0, 2).join(" ")} ${args[4]} failed for ${profile.name} (exit ${status})`);
};

function usage(profiles: Profile[]) {
  const names = profiles.length > 0 ? profiles.map((p) => p.name).join(" | ") : "profile";
  const rows = [
    [`cprof <${names}> [claude args...]`, "start Claude Code as that profile"],
    ["cprof init [--name <name>]", "create profiles.json for your current Claude Code setup"],
    ["cprof status", "show each profile's account, dir and MCP servers"],
    ["cprof list", "show profiles.json: each profile's dir and MCP list"],
    ["cprof add <name> [--dir <path>] [--mcp a,b]", "create a profile (dir defaults to ~/.claude-<name>)"],
    ["cprof edit <name> --mcp +a,-b", "add or remove MCP servers on a profile"],
    ["cprof rename <name> <new-name>", "rename a profile (its folder and login stay put)"],
    ["cprof remove <name>", "drop a profile from profiles.json (its folder is kept)"],
    ["cprof setup", "apply profiles.json: share config, split MCP servers"],
  ];
  const width = Math.max(...rows.map(([c]) => c.length));
  return [
    "usage:",
    ...rows.map(([c, d]) => `  ${c.padEnd(width)}   ${d}`),
    "",
    "init, add, edit, rename, remove and setup take --dry-run to show what would change.",
    `config: ${configPath}`,
  ].join("\n");
}

type Flags = { positional: string[]; dryRun: boolean; values: Record<string, string> };

function parseFlags(args: string[], valueFlags: string[]): Flags {
  const out: Flags = { positional: [], dryRun: false, values: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (valueFlags.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} needs a value`, 2);
      out.values[arg] = value;
    } else if (arg.startsWith("--")) throw new CliError(`unknown option ${arg}`, 2);
    else out.positional.push(arg);
  }
  return out;
}

function oneName(flags: Flags, command: string) {
  if (flags.positional.length !== 1) throw new CliError(`usage: cprof ${command} <name> ...`, 2);
  return flags.positional[0];
}

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Refuses server names that exist nowhere, so a typo doesn't silently land in profiles.json. */
function requireKnown(config: Config, names: string[]) {
  const known = knownServers(config, home);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0)
    throw new CliError(`no profile has MCP server ${unknown.join(", ")} configured; known: ${[...known].sort().join(", ")}`);
}

/** Shows the plan for `cfg` and, unless it's a dry run, applies it. Returns false when the plan has errors. */
function planAndApply(cfg: Config, dry: boolean, opts: PlanOptions = {}): boolean {
  const p = plan(cfg, home, opts);
  for (const w of p.warnings) console.log(`warn: ${w}`);
  for (const e of p.errors) console.error(`error: ${e}`);
  if (p.errors.length > 0) return false;
  if (p.actions.length === 0) console.log("nothing to do");
  else console.log(dry ? "would:" : "doing:");
  for (const a of p.actions) console.log(`  ${describe(a)}`);
  if (!dry) apply(p, runMcp);
  return true;
}

/**
 * Applies a profile change, then saves profiles.json. Saving last means a failure partway leaves
 * profiles.json as it was, so running the same command again picks up where it stopped.
 */
function commit(next: Config, dry: boolean, opts: PlanOptions) {
  if (!planAndApply(next, dry, opts)) return false;
  if (!dry) saveConfig(configPath, next);
  return true;
}

function add(config: Config, args: string[]) {
  const flags = parseFlags(args, ["--dir", "--mcp"]);
  const name = oneName(flags, "add");
  const mcp = splitList(flags.values["--mcp"] ?? "");
  const next = addProfile(config, name, { dir: flags.values["--dir"], mcp });
  if (!flags.values["--dir"]) {
    // A renamed profile keeps its old folder, so ~/.claude-<name> can belong to a profile with another name.
    const wanted = pathKey(expandHome(next.profiles[name].configDir!, home));
    const owner = resolveProfiles(config, home).find((p) => pathKey(p.dir) === wanted);
    if (owner) throw new CliError(`${owner.dir} already belongs to profile "${owner.name}"; choose another folder with --dir`);
  }
  requireKnown(config, mcp);
  if (!commit(next, flags.dryRun, { only: name })) return 1;
  const dir = next.profiles[name].configDir;
  if (flags.dryRun) console.log(`would add profile ${name} at ${dir}`);
  else console.log(`added profile ${name} at ${dir}\nnext: cprof ${name}, then /login with that account`);
  return 0;
}

function edit(config: Config, args: string[]) {
  const flags = parseFlags(args, ["--mcp"]);
  const name = oneName(flags, "edit");
  if (!flags.values["--mcp"]) throw new CliError("usage: cprof edit <name> --mcp +server,-server", 2);
  const items = splitList(flags.values["--mcp"]);
  const remove = items.filter((s) => s.startsWith("-")).map((s) => s.slice(1));
  const added = items.filter((s) => !s.startsWith("-")).map((s) => s.replace(/^\+/, ""));
  const next = editProfileMcp(config, name, { add: added, remove });
  requireKnown(config, added);
  if (!commit(next, flags.dryRun, { only: name, forceRemove: { [name]: remove } })) return 1;
  if (!flags.dryRun) console.log(`${name} now has: ${next.profiles[name].mcp?.join(", ") || "no MCP servers"}`);
  return 0;
}

function remove(config: Config, profiles: Profile[], args: string[]) {
  const flags = parseFlags(args, []);
  const name = oneName(flags, "remove");
  const next = removeProfile(config, name);
  const dir = profiles.find((p) => p.name === name)!.dir;
  if (!flags.dryRun) saveConfig(configPath, next);
  console.log(`${flags.dryRun ? "would remove" : "removed"} ${name} from profiles.json`);
  // The folder holds that account's login and history; deleting it is left to the user.
  if (existsSync(dir)) console.log(`its folder is kept: ${dir} (delete it yourself if you no longer need that login)`);
  return 0;
}

function init(args: string[]) {
  const flags = parseFlags(args, ["--name"]);
  if (flags.positional.length > 0) throw new CliError("usage: cprof init [--name <name>]", 2);
  if (existsSync(configPath)) throw new CliError(`${configPath} already exists; use cprof add, edit or rename`);
  // init describes Claude Code's default setup; a CLAUDE_CONFIG_DIR already in the shell means the user runs a
  // different one, and cprof would later unset it and start that profile logged out.
  const ambient = process.env.CLAUDE_CONFIG_DIR;
  if (ambient)
    throw new CliError(
      `CLAUDE_CONFIG_DIR is set (${ambient}). cprof sets it per profile, so unset it first, run cprof init, ` +
        `then bring that dir in with: cprof add <name> --dir ${ambient}`,
    );
  const name = flags.values["--name"] ?? "main";
  // Start from the servers the default profile already has, so a later setup never removes them.
  const [profile] = resolveProfiles(initialConfig(name, []), home);
  const mcp = Object.keys(readUserMcp(profile.claudeJson));
  const config = initialConfig(name, mcp);
  if (!flags.dryRun) saveConfig(configPath, config);
  console.log(`${flags.dryRun ? "would create" : "created"} ${configPath}`);
  console.log(`  profile ${name}: Claude Code's default dir (~/.claude), MCP: ${mcp.join(", ") || "none"}`);
  console.log(`  shared with other profiles: ${config.shared.join(", ")}`);
  if (!flags.dryRun) console.log("next: cprof add <name> for another account, then cprof <name> and /login");
  return 0;
}

function rename(config: Config, args: string[]) {
  const flags = parseFlags(args, []);
  if (flags.positional.length !== 2) throw new CliError("usage: cprof rename <name> <new-name>", 2);
  const [from, to] = flags.positional;
  const next = renameProfile(config, from, to);
  if (!flags.dryRun) saveConfig(configPath, next);
  console.log(`${flags.dryRun ? "would rename" : "renamed"} ${from} to ${to}; start it with: cprof ${to}`);
  return 0;
}

function list(config: Config, profiles: Profile[]) {
  console.log(`config: ${configPath}`);
  for (const p of profiles) {
    const dir = config.profiles[p.name].configDir ?? "~/.claude (default)";
    console.log(`${p.name}${p.name === config.shareFrom ? " (shares its folders)" : ""}`);
    console.log(`  dir: ${dir}`);
    console.log(`  mcp: ${p.mcp.join(", ") || "none"}`);
  }
  return 0;
}

function status(config: Config, profiles: Profile[]) {
  for (const p of profiles) {
    const data = readClaudeJson(p.claudeJson);
    const missing = new Set(missingShared(config, home, p));
    console.log(`${p.name}${p.isDefault ? " (default config dir)" : ""}`);
    console.log(`  account: ${data.oauthAccount?.emailAddress ?? "not logged in"}`);
    console.log(`  dir:     ${p.dir}`);
    console.log(`  shared:  ${config.shared.map((s) => (missing.has(s) ? `${s} (not linked)` : s)).join(", ")}`);
    console.log(`  mcp:     ${Object.keys(data.mcpServers ?? {}).join(", ") || "none"}`);
  }
  return 0;
}

function launch(config: Config, profile: Profile, args: string[]) {
  const missing = missingShared(config, home, profile);
  if (missing.length > 0)
    throw new CliError(`${profile.name} is not set up yet (${missing.join(", ")} not shared); run: cprof setup`);
  // Ctrl+C reaches Claude through the shared console; cprof just waits for it to exit.
  process.on("SIGINT", () => {});
  return runClaude(profile, args);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "init") return init(rest);

  const config = existsSync(configPath) ? loadConfig(configPath) : undefined;
  const profiles = config ? resolveProfiles(config, home) : [];

  // No silent default: the account is always picked on purpose.
  if (!cmd) {
    console.error(usage(profiles));
    return 2;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage(profiles));
    return 0;
  }
  if (!config) throw new CliError(`no profiles yet (${configPath} doesn't exist); run: cprof init`);
  if (cmd === "rename") return rename(config, rest);
  if (cmd === "setup") return planAndApply(config, parseFlags(rest, []).dryRun) ? 0 : 1;
  if (cmd === "status") return status(config, profiles);
  if (cmd === "list") return list(config, profiles);
  if (cmd === "add") return add(config, rest);
  if (cmd === "edit") return edit(config, rest);
  if (cmd === "remove") return remove(config, profiles, rest);

  const profile = profiles.find((p) => p.name === cmd);
  if (!profile) throw new CliError(`unknown profile "${cmd}"\n${usage(profiles)}`, 2);
  return launch(config, profile, rest);
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error(`cprof: ${(e as Error).message}`);
  process.exit(e instanceof CliError ? e.code : 1);
}
