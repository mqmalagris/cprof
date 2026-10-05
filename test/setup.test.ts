import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addProfile,
  type Config,
  configPathFor,
  editProfileMcp,
  envFor,
  initialConfig,
  loadConfig,
  removeProfile,
  renameProfile,
  resolveProfiles,
} from "../src/config";
import { apply, type McpRunner, plan, readUserMcp } from "../src/setup";
import { config, makeHome } from "./fixture";

let home: string;

// Stands in for `claude mcp add-json/remove -s user`, editing the profile's .claude.json directly.
const fakeMcp: McpRunner = (profile, args) => {
  const data = existsSync(profile.claudeJson) ? JSON.parse(readFileSync(profile.claudeJson, "utf8")) : {};
  data.mcpServers ??= {};
  const [, sub, , , name, json] = args; // mcp <sub> -s user <name> [json]
  if (sub === "add-json") data.mcpServers[name] = JSON.parse(json);
  else delete data.mcpServers[name];
  writeFileSync(profile.claudeJson, JSON.stringify(data));
};

const linkType = process.platform === "win32" ? "junction" : "dir";

beforeEach(() => {
  home = makeHome();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeConfig(content: unknown) {
  const path = join(home, "profiles.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("setup gives the new profile shared skills, memory and instructions, but its own settings and history", () => {
  apply(plan(config, home), fakeMcp);
  const personal = join(home, ".claude-personal");

  expect(readFileSync(join(personal, "skills/demo/SKILL.md"), "utf8")).toBe("demo");
  writeFileSync(join(personal, "projects/mem/note.md"), "remembered");
  expect(readFileSync(join(home, ".claude/projects/mem/note.md"), "utf8")).toBe("remembered");
  expect(readFileSync(join(personal, "CLAUDE.md"), "utf8")).toBe("@~/.claude/CLAUDE.md\n");

  writeFileSync(join(personal, "settings.json"), '{"model":"sonnet"}');
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe('{"model":"opus"}');
  expect(existsSync(join(personal, "history.jsonl"))).toBe(false);
});

test("a server moved from work to personal arrives with its original definition, and unlisted ones stay put", () => {
  const p = plan(config, home);
  expect(p.warnings.some((w) => w.includes('"mystery"'))).toBe(true);
  apply(p, fakeMcp);

  const [work, personal] = resolveProfiles(config, home);
  expect(Object.keys(readUserMcp(work.claudeJson)).sort()).toEqual(["mystery", "playwright", "tracker"]);
  expect(Object.keys(readUserMcp(personal.claudeJson)).sort()).toEqual(["playwright", "stitch"]);
  expect(readUserMcp(personal.claudeJson).stitch).toEqual({ type: "http", url: "https://stitch.example/mcp" });
  // the work login is untouched by the edit
  expect(JSON.parse(readFileSync(work.claudeJson, "utf8")).oauthAccount.emailAddress).toBe("me@work.example");
});

test("a server only scoped to a work project folder can still be added user-wide to personal", () => {
  const data = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  data.projects = { "C:/proj": { mcpServers: { tool21: { type: "http", url: "https://21.example/mcp" } } } };
  writeFileSync(join(home, ".claude.json"), JSON.stringify(data));
  const cfg: Config = { ...config, profiles: { ...config.profiles, personal: { ...config.profiles.personal, mcp: ["tool21"] } } };

  const p = plan(cfg, home);
  expect(p.warnings.some((w) => w.includes('"tool21" is still in work for C:/proj'))).toBe(true);
  apply(p, fakeMcp);
  const [, personal] = resolveProfiles(cfg, home);
  expect(readUserMcp(personal.claudeJson).tool21).toEqual({ type: "http", url: "https://21.example/mcp" });
});

test("setup backs up a profile's .claude.json before changing its MCP servers", () => {
  apply(plan(config, home, { now: new Date("2026-10-03T12:00:00Z") }), fakeMcp);
  const backup = join(home, ".claude.json.cprof-backup-2026-10-03T12-00-00-000Z");
  expect(Object.keys(JSON.parse(readFileSync(backup, "utf8")).mcpServers)).toContain("stitch");
});

test("when claude mcp fails partway, the backup taken before it is still there to restore from", () => {
  const failing: McpRunner = (profile, args) => {
    if (args[1] === "add-json") throw new Error("claude mcp add-json failed");
    fakeMcp(profile, args);
  };
  expect(() => apply(plan(config, home, { now: new Date("2026-10-03T12:00:00Z") }), failing)).toThrow("add-json failed");
  const backup = join(home, ".claude.json.cprof-backup-2026-10-03T12-00-00-000Z");
  expect(Object.keys(JSON.parse(readFileSync(backup, "utf8")).mcpServers)).toContain("stitch");
});

test("running setup again changes nothing", () => {
  apply(plan(config, home), fakeMcp);
  expect(plan(config, home).actions).toEqual([]);
});

test("setup keeps a personal CLAUDE.md and settings.json that already exist", () => {
  mkdirSync(join(home, ".claude-personal"));
  writeFileSync(join(home, ".claude-personal/CLAUDE.md"), "# my own");
  writeFileSync(join(home, ".claude-personal/settings.json"), '{"model":"haiku"}');
  const p = plan(config, home);
  expect(p.warnings.some((w) => w.includes('add "@~/.claude/CLAUDE.md"'))).toBe(true);
  apply(p, fakeMcp);
  expect(readFileSync(join(home, ".claude-personal/CLAUDE.md"), "utf8")).toBe("# my own");
  expect(readFileSync(join(home, ".claude-personal/settings.json"), "utf8")).toBe('{"model":"haiku"}');
});

test("setup refuses to replace a folder that already has content", () => {
  mkdirSync(join(home, ".claude-personal/skills/own"), { recursive: true });
  const p = plan(config, home);
  expect(p.errors).toEqual([expect.stringContaining("already exists with its own content")]);
  expect(() => apply(p, fakeMcp)).toThrow("refusing to apply");
  expect(existsSync(join(home, ".claude-personal/commands"))).toBe(false);
});

test("setup refuses to replace a link that points somewhere else", () => {
  mkdirSync(join(home, "elsewhere"));
  mkdirSync(join(home, ".claude-personal"));
  symlinkSync(join(home, "elsewhere"), join(home, ".claude-personal/skills"), linkType);
  expect(plan(config, home).errors).toEqual([expect.stringContaining("is a link to somewhere else")]);
});

test("setup refuses to share a file as if it were a folder", () => {
  writeFileSync(join(home, ".claude/keybindings.json"), "{}");
  const p = plan({ ...config, shared: ["keybindings.json"] }, home);
  expect(p.errors).toEqual([expect.stringContaining("only folders can be shared")]);
});

test("an empty folder left by an earlier launch is replaced by the shared one", () => {
  mkdirSync(join(home, ".claude-personal/projects"), { recursive: true });
  apply(plan(config, home), fakeMcp);
  expect(existsSync(join(home, ".claude-personal/projects/mem"))).toBe(true);
});

test("a shared folder the main profile doesn't have is skipped with a warning", () => {
  const p = plan({ ...config, shared: ["skills", "agents"] }, home);
  expect(p.warnings).toContain("work has no agents; not sharing it with personal");
  expect(p.actions.some((a) => a.kind === "link" && a.link.endsWith("agents"))).toBe(false);
});

test("the default profile runs with CLAUDE_CONFIG_DIR unset, others point at their dir", () => {
  const [work, personal] = resolveProfiles(config, home);
  expect(envFor(work, { CLAUDE_CONFIG_DIR: "/somewhere", PATH: "x" })).toEqual({ PATH: "x" });
  expect(envFor(personal, {}).CLAUDE_CONFIG_DIR).toBe(join(home, ".claude-personal"));
});

test("profiles.json problems are all reported at once", () => {
  const path = writeConfig({
    shareFrom: "nobody",
    shared: ["../escape"],
    profiles: {
      setup: { configDir: null },
      a: { configDir: null },
      b: {},
      c: { configDir: "relative/dir" },
      d: { configDir: "~/.d", mcp: "stitch" },
    },
  });
  const message = (() => {
    try {
      loadConfig(path);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  for (const expected of [
    'shareFrom "nobody" is not a profile',
    "shared must be a list of folder names",
    '"setup" is a reserved command name',
    "b: configDir must be null",
    "c: configDir must be null",
    "d: mcp must be a list",
    "only one profile can use the default config dir",
  ])
    expect(message).toContain(expected);
});

test("an unreadable profiles.json gives a plain error", () => {
  expect(() => loadConfig(writeConfig("{ not json"))).toThrow(/^cannot read .*profiles\.json/);
  expect(() => loadConfig(join(home, "missing.json"))).toThrow(/^cannot read .*missing\.json/);
});

test("a ~\\ path works as a home path", () => {
  const cfg = loadConfig(writeConfig({ ...config, profiles: { ...config.profiles, personal: { configDir: "~\\.p" } } }));
  expect(resolveProfiles(cfg, home)[1].dir).toBe(join(home, ".p"));
});

test("a new profile defaults to its own ~/.claude-<name> dir", () => {
  const next = addProfile(config, "client", { mcp: ["playwright"] });
  expect(next.profiles.client).toEqual({ configDir: "~/.claude-client", mcp: ["playwright"] });
  expect(config.profiles.client).toBeUndefined();
});

test("adding a profile that exists, uses a command name, or has an odd name is refused", () => {
  expect(() => addProfile(config, "personal")).toThrow('profile "personal" already exists; use: cprof edit personal');
  expect(() => addProfile(config, "list")).toThrow('"list" is a reserved command name');
  expect(() => addProfile(config, "my client")).toThrow('"my client" must be letters, digits, - or _');
  expect(() => addProfile(config, "x", { dir: "relative" })).toThrow("x: configDir must be null");
});

test("editing MCP keeps the existing order, appends new servers and ignores repeats", () => {
  const next = editProfileMcp(config, "work", { add: ["stitch", "playwright"], remove: ["tracker"] });
  expect(next.profiles.work.mcp).toEqual(["playwright", "stitch"]);
});

test("repeated server names in an edit are applied once", () => {
  const next = editProfileMcp(config, "personal", { add: ["tracker", "tracker"], remove: ["stitch", "stitch"] });
  expect(next.profiles.personal.mcp).toEqual(["playwright", "tracker"]);
});

test("profile names that match built-in object keys are treated like any other name", () => {
  const name: string = "constructor";
  expect(addProfile(config, name).profiles[name]).toEqual({ configDir: "~/.claude-constructor", mcp: [] });
  expect(() => removeProfile(config, "toString")).toThrow('unknown profile "toString"');
  expect(() => editProfileMcp(config, "toString", { add: [], remove: [] })).toThrow('unknown profile "toString"');
});

test("removing a server a profile doesn't list is refused", () => {
  expect(() => editProfileMcp(config, "work", { add: [], remove: ["stitch"] })).toThrow("work doesn't list stitch");
  expect(() => editProfileMcp(config, "nobody", { add: [], remove: [] })).toThrow('unknown profile "nobody"');
});

test("the profile shared folders come from can't be removed", () => {
  expect(() => removeProfile(config, "work")).toThrow("can't be removed");
  expect(Object.keys(removeProfile(config, "personal").profiles)).toEqual(["work"]);
});

test("a server explicitly taken off a profile is removed even when no other profile lists it", () => {
  const next = editProfileMcp(config, "work", { add: [], remove: ["tracker"] });
  expect(plan(next, home).actions.some((a) => a.kind === "mcp-remove" && a.name === "tracker")).toBe(false);
  const p = plan(next, home, { forceRemove: { work: ["tracker"] } });
  apply(p, fakeMcp);
  expect(Object.keys(readUserMcp(join(home, ".claude.json")))).not.toContain("tracker");
});

test("the config path comes from CPROF_CONFIG, then an absolute XDG_CONFIG_HOME, then ~/.config", () => {
  const xdg = join(home, "xdg");
  expect(configPathFor(home, { CPROF_CONFIG: "/x/p.json", XDG_CONFIG_HOME: xdg })).toBe("/x/p.json");
  expect(configPathFor(home, { XDG_CONFIG_HOME: xdg })).toBe(join(xdg, "cprof", "profiles.json"));
  expect(configPathFor(home, { XDG_CONFIG_HOME: "relative" })).toBe(join(home, ".config", "cprof", "profiles.json"));
  expect(configPathFor(home, { CPROF_CONFIG: "" })).toBe(join(home, ".config", "cprof", "profiles.json"));
});

test("a first config has one default-dir profile that shares the usual folders", () => {
  expect(initialConfig("work", ["a", "a", "b"])).toEqual({
    shareFrom: "work",
    shared: ["skills", "commands", "projects"],
    profiles: { work: { configDir: null, mcp: ["a", "b"] } },
  });
  expect(() => initialConfig("setup", [])).toThrow('"setup" is a reserved command name');
});

test("renaming keeps the profile's settings and place, and follows shareFrom", () => {
  const next = renameProfile(config, "work", "job");
  expect(Object.keys(next.profiles)).toEqual(["job", "personal"]);
  expect(next.profiles.job).toEqual(config.profiles.work);
  expect(next.shareFrom).toBe("job");
  expect(renameProfile(config, "personal", "home").shareFrom).toBe("work");
});

test("renaming to the same name, a taken name or from an unknown one is refused", () => {
  expect(() => renameProfile(config, "work", "work")).toThrow("work already has that name");
  expect(() => renameProfile(config, "work", "personal")).toThrow('profile "personal" already exists');
  expect(() => renameProfile(config, "nope", "x")).toThrow('unknown profile "nope"');
});

test("two profiles on the same dir are rejected", () => {
  const cfg: Config = { ...config, profiles: { ...config.profiles, personal: { configDir: "~/.claude" } } };
  expect(() => resolveProfiles(cfg, home)).toThrow('profiles "work" and "personal" resolve to the same dir');
});
