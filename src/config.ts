import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ProfileDef = { configDir: string | null; mcp?: string[] };
export type Config = { shareFrom: string; shared: string[]; profiles: Record<string, ProfileDef> };

export type Profile = {
  name: string;
  /** Directory Claude Code treats as its config dir (~/.claude for the default profile). */
  dir: string;
  /** Where this profile keeps login, MCP servers and other account state. */
  claudeJson: string;
  /** The default profile runs with CLAUDE_CONFIG_DIR unset; pointing it at ~/.claude would move .claude.json. */
  isDefault: boolean;
  mcp: string[];
};

export const RESERVED = new Set([
  "init", "setup", "status", "list", "add", "edit", "rename", "remove", "help", "--help", "-h",
]);

/** Folders shared by default: skills, slash commands, and projects (memory and session transcripts). */
export const DEFAULT_SHARED = ["skills", "commands", "projects"];

/** profiles.json lives outside the install so upgrades never touch it: $CPROF_CONFIG, else XDG config dir. */
export function configPathFor(home: string, env: Record<string, string | undefined>) {
  if (env.CPROF_CONFIG) return env.CPROF_CONFIG;
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "cprof", "profiles.json");
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
// A shared entry is one folder name inside the config dir, never a path that could escape it.
const isPlainName = (s: string) => s.length > 0 && !/[\\/]/.test(s) && s !== "." && s !== "..";
const isHomeOrAbsolute = (p: string) => p === "~" || /^~[\\/]/.test(p) || isAbsolute(p);
// Profile names are typed as the first CLI argument and become part of a default dir name.
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

// Own keys only: a plain `profiles[name]` would also match "constructor" or "toString".
export const hasProfile = (config: Config, name: string) =>
  typeof config.profiles === "object" && config.profiles !== null && Object.hasOwn(config.profiles, name);

const unique = (names: string[]) => [...new Set(names)];

export function validateConfig(config: Config): string[] {
  const problems: string[] = [];
  const names = Object.keys(config.profiles ?? {});
  if (names.length === 0) problems.push("no profiles defined");
  if (!hasProfile(config, config.shareFrom)) problems.push(`shareFrom "${config.shareFrom}" is not a profile`);
  if (!isStringArray(config.shared) || !config.shared.every(isPlainName))
    problems.push("shared must be a list of folder names inside the config dir");
  for (const name of names) {
    const def = config.profiles[name];
    if (RESERVED.has(name)) problems.push(`"${name}" is a reserved command name`);
    else if (!PROFILE_NAME.test(name)) problems.push(`"${name}" must be letters, digits, - or _`);
    if (def.configDir !== null && (typeof def.configDir !== "string" || !isHomeOrAbsolute(def.configDir)))
      problems.push(`${name}: configDir must be null (default dir), a ~/ path or an absolute path`);
    if (def.mcp !== undefined && !isStringArray(def.mcp)) problems.push(`${name}: mcp must be a list of server names`);
  }
  if (names.filter((n) => config.profiles[n].configDir === null).length > 1)
    problems.push("only one profile can use the default config dir (configDir: null)");
  return problems;
}

export function loadConfig(path: string): Config {
  let config: Config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`${path}:\n  ${problems.join("\n  ")}`);
  return config;
}

export function saveConfig(path: string, config: Config) {
  // Write then rename, so a crash mid-write can't leave a truncated profiles.json that stops every command.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

function checked(config: Config): Config {
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return config;
}

export function addProfile(config: Config, name: string, opts: { dir?: string; mcp?: string[] } = {}): Config {
  if (hasProfile(config, name)) throw new Error(`profile "${name}" already exists; use: cprof edit ${name}`);
  const def: ProfileDef = { configDir: opts.dir ?? `~/.claude-${name}`, mcp: unique(opts.mcp ?? []) };
  return checked({ ...config, profiles: { ...config.profiles, [name]: def } });
}

export type McpChange = { add: string[]; remove: string[] };

export function editProfileMcp(config: Config, name: string, change: McpChange): Config {
  if (!hasProfile(config, name)) throw new Error(`unknown profile "${name}"`);
  const def = config.profiles[name];
  const current = def.mcp ?? [];
  const notListed = unique(change.remove).filter((s) => !current.includes(s));
  if (notListed.length > 0) throw new Error(`${name} doesn't list ${notListed.join(", ")}`);
  const added = unique(change.add).filter((s) => !current.includes(s));
  const mcp = [...current.filter((s) => !change.remove.includes(s)), ...added];
  return checked({ ...config, profiles: { ...config.profiles, [name]: { ...def, mcp } } });
}

/** A first config: one profile on Claude Code's default dir, keeping the MCP servers it already has. */
export function initialConfig(name: string, mcp: string[]): Config {
  return checked({ shareFrom: name, shared: [...DEFAULT_SHARED], profiles: { [name]: { configDir: null, mcp: unique(mcp) } } });
}

/** Renames the profile only; its dir and login stay where they are. */
export function renameProfile(config: Config, from: string, to: string): Config {
  if (!hasProfile(config, from)) throw new Error(`unknown profile "${from}"`);
  if (from === to) throw new Error(`${from} already has that name`);
  if (hasProfile(config, to)) throw new Error(`profile "${to}" already exists`);
  // Rebuilt in order so the renamed profile keeps its place in profiles.json.
  const profiles = Object.fromEntries(Object.entries(config.profiles).map(([n, def]) => [n === from ? to : n, def]));
  return checked({ ...config, shareFrom: config.shareFrom === from ? to : config.shareFrom, profiles });
}

export function removeProfile(config: Config, name: string): Config {
  if (!hasProfile(config, name)) throw new Error(`unknown profile "${name}"`);
  if (name === config.shareFrom) throw new Error(`${name} is where shared folders come from (shareFrom) and can't be removed`);
  const { [name]: _, ...profiles } = config.profiles;
  return checked({ ...config, profiles });
}

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : /^~[\\/]/.test(p) ? join(home, p.slice(2)) : p;
}

/** Comparable form of a path: absolute, and case-folded on Windows. */
export const pathKey = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

export function resolveProfiles(config: Config, home: string): Profile[] {
  const profiles = Object.entries(config.profiles).map(([name, def]) => {
    const isDefault = def.configDir === null;
    const dir = isDefault ? join(home, ".claude") : expandHome(def.configDir!, home);
    return {
      name,
      dir,
      claudeJson: isDefault ? join(home, ".claude.json") : join(dir, ".claude.json"),
      isDefault,
      mcp: def.mcp ?? [],
    };
  });
  // Two profiles sharing a dir or a .claude.json would share a login and undo each other's MCP changes.
  // Both paths are checked: a profile at ~ has its own dir but the default profile's ~/.claude.json.
  for (const [label, pathOf] of [
    ["dir", (p: Profile) => p.dir],
    [".claude.json", (p: Profile) => p.claudeJson],
  ] as const) {
    const seen = new Map<string, string>();
    for (const p of profiles) {
      const other = seen.get(pathKey(pathOf(p)));
      if (other) throw new Error(`profiles "${other}" and "${p.name}" resolve to the same ${label} ${pathOf(p)}`);
      seen.set(pathKey(pathOf(p)), p.name);
    }
  }
  return profiles;
}

export function envFor(profile: Profile, env: Record<string, string | undefined>) {
  const next = { ...env };
  if (profile.isDefault) delete next.CLAUDE_CONFIG_DIR;
  else next.CLAUDE_CONFIG_DIR = profile.dir;
  return next;
}
