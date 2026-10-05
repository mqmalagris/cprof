import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type Config, type Profile, resolveProfiles } from "./config";

export type McpServers = Record<string, unknown>;

export type Action =
  | { kind: "mkdir"; path: string }
  | { kind: "link"; link: string; target: string; replaceEmptyDir: boolean }
  | { kind: "write"; path: string; content: string; why: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "backup"; from: string; to: string }
  | { kind: "mcp-add"; profile: Profile; name: string; server: unknown }
  | { kind: "mcp-remove"; profile: Profile; name: string };

export type Plan = { actions: Action[]; warnings: string[]; errors: string[] };

/** Runs `claude mcp ...` for a profile. Swapped out in tests. */
export type McpRunner = (profile: Profile, args: string[]) => void;

type ClaudeJson = {
  oauthAccount?: { emailAddress?: string };
  mcpServers?: McpServers;
  projects?: Record<string, { mcpServers?: McpServers }>;
};

export function readClaudeJson(claudeJson: string): ClaudeJson {
  if (!existsSync(claudeJson)) return {};
  try {
    return JSON.parse(readFileSync(claudeJson, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${claudeJson}: ${(e as Error).message}`);
  }
}

export function readUserMcp(claudeJson: string): McpServers {
  return readClaudeJson(claudeJson).mcpServers ?? {};
}

/** Servers added with `-s local` live per project folder; cprof manages user scope only. */
function projectMcp(data: ClaudeJson) {
  return Object.entries(data.projects ?? {})
    .filter(([, v]) => v.mcpServers && Object.keys(v.mcpServers).length > 0)
    .map(([project, v]) => ({ project, servers: v.mcpServers! }));
}

function samePath(a: string, b: string) {
  const norm = (p: string) => {
    const r = realpathSync(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function tildePath(p: string, home: string) {
  const rel = relative(home, p);
  // relative() returns an absolute path when p is on another Windows drive.
  const outside = isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
  return outside ? p.replaceAll("\\", "/") : `~/${rel.replaceAll("\\", "/")}`;
}

/** Shared folders a profile still lacks; launching before they exist lets Claude create real ones in their place. */
export function missingShared(config: Config, home: string, profile: Profile): string[] {
  const base = resolveProfiles(config, home).find((p) => p.name === config.shareFrom)!;
  if (profile.name === base.name) return [];
  return config.shared.filter((name) => {
    const target = join(base.dir, name);
    const link = join(profile.dir, name);
    return existsSync(target) && !(existsSync(link) && samePath(link, target));
  });
}

function planShared(config: Config, base: Profile, p: Profile, home: string, out: Plan) {
  if (!existsSync(p.dir)) out.actions.push({ kind: "mkdir", path: p.dir });

  for (const name of config.shared) {
    const target = join(base.dir, name);
    const link = join(p.dir, name);
    if (!existsSync(target)) {
      out.warnings.push(`${base.name} has no ${name}; not sharing it with ${p.name}`);
      continue;
    }
    if (!statSync(target).isDirectory()) {
      out.errors.push(`${target} is a file; only folders can be shared`);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(link);
    } catch {
      out.actions.push({ kind: "link", link, target, replaceEmptyDir: false });
      continue;
    }
    if (existsSync(link) && samePath(link, target)) continue;
    if (stat.isSymbolicLink()) out.errors.push(`${link} is a link to somewhere else; remove it and re-run`);
    else if (stat.isDirectory() && readdirSync(link).length === 0)
      out.actions.push({ kind: "link", link, target, replaceEmptyDir: true });
    else out.errors.push(`${link} already exists with its own content; move it aside and re-run`);
  }

  // CLAUDE.md is shared through an @import, not a link: Windows file symlinks need admin,
  // and hard links silently split the first time an editor saves by replacing the file.
  const baseMd = join(base.dir, "CLAUDE.md");
  const md = join(p.dir, "CLAUDE.md");
  if (existsSync(baseMd)) {
    const line = `@${tildePath(baseMd, home)}`;
    if (!existsSync(md)) out.actions.push({ kind: "write", path: md, content: `${line}\n`, why: `import ${base.name}'s CLAUDE.md` });
    else if (!readFileSync(md, "utf8").includes(line))
      out.warnings.push(`${md} has its own content; add "${line}" to it to share ${base.name}'s instructions`);
  }

  // settings.json holds hooks and the /model choice, so each profile gets its own copy to edit.
  const baseSettings = join(base.dir, "settings.json");
  const settings = join(p.dir, "settings.json");
  if (existsSync(baseSettings) && !existsSync(settings)) out.actions.push({ kind: "copy", from: baseSettings, to: settings });
}

/** Every MCP server name configured in any profile, user- or project-scoped. */
export function knownServers(config: Config, home: string): Set<string> {
  const names = new Set<string>();
  for (const p of resolveProfiles(config, home)) {
    const data = readClaudeJson(p.claudeJson);
    for (const name of Object.keys(data.mcpServers ?? {})) names.add(name);
    for (const { servers } of projectMcp(data)) for (const name of Object.keys(servers)) names.add(name);
  }
  return names;
}

export type PlanOptions = {
  now?: Date;
  /** Servers the user explicitly took off a profile; removed even if no other profile lists them. */
  forceRemove?: Record<string, string[]>;
  /** Plan changes for this profile only; others are still read as sources for MCP definitions. */
  only?: string;
};

function planMcp(profiles: Profile[], opts: PlanOptions, out: Plan) {
  const now = opts.now ?? new Date();
  const forced = (p: Profile, name: string) => opts.forceRemove?.[p.name]?.includes(name) ?? false;
  const state = new Map(profiles.map((p) => [p.name, readClaudeJson(p.claudeJson)]));
  const userScope = (p: Profile) => state.get(p.name)!.mcpServers ?? {};
  const projectScope = (p: Profile) => projectMcp(state.get(p.name)!);
  const listedBy = (name: string) => profiles.filter((p) => p.mcp.includes(name));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // Definitions are read before anything is applied, so moving a server between profiles in one run is safe.
  // User-scope definitions win; a project-scoped one is the fallback source to copy from.
  const findSource = (name: string) =>
    profiles.map((q) => userScope(q)[name]).find((s) => s !== undefined) ??
    profiles.flatMap(projectScope).map((e) => e.servers[name]).find((s) => s !== undefined);

  for (const p of profiles) {
    if (opts.only !== undefined && p.name !== opts.only) continue;
    const current = userScope(p);
    const mcpActions: Action[] = [];
    for (const name of p.mcp) {
      if (name in current) continue;
      // Kept project-scoped on purpose: going user-wide would expose it in every project of this profile.
      if (projectScope(p).some((e) => name in e.servers)) {
        out.warnings.push(`MCP server "${name}" is scoped to a project folder in ${p.name}, not added user-wide`);
        continue;
      }
      const source = findSource(name);
      if (source === undefined) out.warnings.push(`MCP server "${name}" (wanted by ${p.name}) is not configured in any profile`);
      else mcpActions.push({ kind: "mcp-add", profile: p, name, server: source });
    }
    for (const { project, servers } of projectScope(p))
      for (const name of Object.keys(servers))
        if (!p.mcp.includes(name) && listedBy(name).length > 0)
          out.warnings.push(`MCP server "${name}" is still in ${p.name} for ${project}; remove it there with: claude mcp remove -s local ${name}`);
    for (const name of Object.keys(current)) {
      if (p.mcp.includes(name)) continue;
      if (listedBy(name).length > 0 || forced(p, name)) mcpActions.push({ kind: "mcp-remove", profile: p, name });
      else out.warnings.push(`MCP server "${name}" in ${p.name} is not listed in profiles.json; left alone`);
    }
    if (mcpActions.length > 0 && existsSync(p.claudeJson))
      out.actions.push({ kind: "backup", from: p.claudeJson, to: `${p.claudeJson}.cprof-backup-${stamp}` });
    out.actions.push(...mcpActions);
  }
}

export function plan(config: Config, home: string, opts: PlanOptions = {}): Plan {
  const profiles = resolveProfiles(config, home);
  const base = profiles.find((p) => p.name === config.shareFrom)!;
  const out: Plan = { actions: [], warnings: [], errors: [] };
  for (const p of profiles)
    if (p !== base && (opts.only === undefined || p.name === opts.only)) planShared(config, base, p, home, out);
  planMcp(profiles, opts, out);
  return out;
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "mkdir": return `create ${a.path}`;
    case "link": return `link ${a.link} -> ${a.target}`;
    case "write": return `write ${a.path} (${a.why})`;
    case "copy": return `copy ${a.from} -> ${a.to}`;
    case "backup": return `back up ${a.from} -> ${a.to}`;
    case "mcp-add": return `add MCP server ${a.name} to ${a.profile.name}`;
    case "mcp-remove": return `remove MCP server ${a.name} from ${a.profile.name}`;
  }
}

export function apply(p: Plan, runMcp: McpRunner) {
  if (p.errors.length > 0) throw new Error(`refusing to apply, fix these first:\n${p.errors.join("\n")}`);
  for (const a of p.actions) {
    switch (a.kind) {
      case "mkdir":
        mkdirSync(a.path, { recursive: true });
        break;
      case "link":
        if (a.replaceEmptyDir) rmdirSync(a.link);
        // Junctions need no admin rights or Developer Mode on Windows.
        symlinkSync(a.target, a.link, process.platform === "win32" ? "junction" : "dir");
        break;
      case "write":
        writeFileSync(a.path, a.content);
        break;
      case "copy":
      case "backup":
        copyFileSync(a.from, a.to);
        break;
      case "mcp-add":
        runMcp(a.profile, ["mcp", "add-json", "-s", "user", a.name, JSON.stringify(a.server)]);
        break;
      case "mcp-remove":
        runMcp(a.profile, ["mcp", "remove", "-s", "user", a.name]);
        break;
    }
  }
}
