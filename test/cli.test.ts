import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, makeHome } from "./fixture";

const root = join(import.meta.dir, "..");
let binDir: string;
let fakeClaude: string;
let home: string;
let configPath: string;
let log: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "cprof-bin-"));
  fakeClaude = join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
  const built = spawnSync(process.execPath, ["build", "--compile", join(import.meta.dir, "fake-claude.ts"), "--outfile", fakeClaude], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`could not build fake claude: ${built.stderr}`);
}, 60_000);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

beforeEach(() => {
  home = makeHome();
  configPath = join(home, "profiles.json");
  writeFileSync(configPath, JSON.stringify(config));
  log = join(home, "claude-calls.jsonl");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Runs the real CLI against the temp home. An env value of undefined removes that variable. */
function cprof(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    CPROF_CONFIG: configPath,
    CPROF_CLAUDE: fakeClaude,
    FAKE_CLAUDE_LOG: log,
    ...env,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const r = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], { encoding: "utf8", env: merged });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const claudeCalls = (): { args: string[]; configDir: string | null }[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("bare cprof refuses to pick an account and lists the profiles", () => {
  const r = cprof([]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("cprof <work | personal>");
  expect(claudeCalls()).toEqual([]);
});

test("an unknown profile is rejected", () => {
  const r = cprof(["play"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain('unknown profile "play"');
});

test("personal won't start before setup, so Claude can't create folders where the shared ones go", () => {
  const r = cprof(["personal"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("personal is not set up yet");
  expect(r.err).toContain("run: cprof setup");
  expect(claudeCalls()).toEqual([]);
  expect(existsSync(join(home, ".claude-personal"))).toBe(false);
});

test("setup --dry-run shows the plan and changes nothing", () => {
  const before = readFileSync(join(home, ".claude.json"), "utf8");
  const r = cprof(["setup", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would:");
  expect(r.out).toContain("add MCP server stitch to personal");
  expect(existsSync(join(home, ".claude-personal"))).toBe(false);
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
  expect(claudeCalls()).toEqual([]);
});

test("after setup, status shows each account with its own MCP servers and everything shared", () => {
  expect(cprof(["setup"]).code).toBe(0);
  const r = cprof(["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("work (default config dir)\n  account: me@work.example");
  expect(r.out).toContain("personal\n  account: not logged in");
  expect(r.out).toContain("  mcp:     playwright, stitch");
  expect(r.out).not.toContain("not linked");
});

test("setup changes MCP servers through claude itself, under each profile's own config", () => {
  cprof(["setup"]);
  const mcp = claudeCalls().filter((c) => c.args[0] === "mcp");
  expect(mcp).toContainEqual({ args: ["mcp", "remove", "-s", "user", "stitch"], configDir: null });
  expect(mcp).toContainEqual({
    args: ["mcp", "add-json", "-s", "user", "stitch", '{"type":"http","url":"https://stitch.example/mcp"}'],
    configDir: join(home, ".claude-personal"),
  });
});

test("each profile starts claude under its own config, passing args and exit code through", () => {
  cprof(["setup"]);
  writeFileSync(log, "");

  expect(cprof(["personal", "--resume", "abc"], { FAKE_CLAUDE_EXIT: "7" }).code).toBe(7);
  expect(cprof(["work"], { CLAUDE_CONFIG_DIR: join(home, "stray") }).code).toBe(0);
  expect(claudeCalls()).toEqual([
    { args: ["--resume", "abc"], configDir: join(home, ".claude-personal") },
    { args: [], configDir: null },
  ]);
});

test("a failing claude mcp call stops setup with a clear message and leaves the backup", () => {
  const r = cprof(["setup"], { FAKE_CLAUDE_FAIL_MCP: "1" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("cprof: claude mcp remove stitch failed for work (exit 3)");
  expect(readdirSync(home).some((f) => f.startsWith(".claude.json.cprof-backup-"))).toBe(true);
});

test("a claude binary that can't be started is reported, not swallowed", () => {
  cprof(["setup"]);
  const r = cprof(["work"], { CPROF_CLAUDE: join(home, "no-such-claude") });
  expect(r.code).toBe(1);
  expect(r.err).toContain("cprof: could not start claude for work");
});

const savedConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const userMcp = (claudeJson: string) => Object.keys(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers ?? {}).sort();

test("add creates a profile that shares skills and memory and gets only the servers asked for", () => {
  cprof(["setup"]);
  const r = cprof(["add", "client", "--mcp", "playwright,tracker"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("next: cprof client, then /login");

  expect(savedConfig().profiles.client).toEqual({ configDir: "~/.claude-client", mcp: ["playwright", "tracker"] });
  expect(readFileSync(join(home, ".claude-client/skills/demo/SKILL.md"), "utf8")).toBe("demo");
  expect(existsSync(join(home, ".claude-client/projects/mem"))).toBe(true);
  expect(userMcp(join(home, ".claude-client/.claude.json"))).toEqual(["playwright", "tracker"]);
  // the other profiles keep what they had
  expect(userMcp(join(home, ".claude.json"))).toEqual(["mystery", "playwright", "tracker"]);
  expect(userMcp(join(home, ".claude-personal/.claude.json"))).toEqual(["playwright", "stitch"]);
  expect(cprof(["client"]).code).toBe(0);
});

test("add --dry-run shows the plan and changes nothing", () => {
  const before = readFileSync(configPath, "utf8");
  const r = cprof(["add", "client", "--dir", "~/elsewhere", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would add profile client at ~/elsewhere");
  expect(r.out).toContain(`create ${join(home, "elsewhere")}`);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(existsSync(join(home, "elsewhere"))).toBe(false);
});

test("add refuses a server name nobody has configured, so a typo doesn't get saved", () => {
  const before = readFileSync(configPath, "utf8");
  const r = cprof(["add", "client", "--mcp", "playwrite"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no profile has MCP server playwrite configured; known: mystery, playwright, stitch, tracker");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("add doesn't save the profile when its folder can't be set up", () => {
  mkdirSync(join(home, ".claude-client/skills/own"), { recursive: true });
  const before = readFileSync(configPath, "utf8");
  expect(cprof(["add", "client"]).code).toBe(1);
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("edit adds and removes servers, removing one even when no other profile lists it", () => {
  cprof(["setup"]);
  const r = cprof(["edit", "work", "--mcp", "+stitch,-tracker"]);
  expect(r.code).toBe(0);
  expect(savedConfig().profiles.work.mcp).toEqual(["playwright", "stitch"]);
  expect(userMcp(join(home, ".claude.json"))).toEqual(["mystery", "playwright", "stitch"]);
  // personal still lists stitch, so it keeps its copy
  expect(userMcp(join(home, ".claude-personal/.claude.json"))).toEqual(["playwright", "stitch"]);
  expect(readdirSync(home).filter((f) => f.startsWith(".claude.json.cprof-backup-")).length).toBeGreaterThan(0);
});

test("edit refuses to remove a server the profile doesn't list", () => {
  const r = cprof(["edit", "personal", "--mcp", "-tracker"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("personal doesn't list tracker");
});

test("remove drops the profile from profiles.json but keeps its folder and login", () => {
  cprof(["setup"]);
  const r = cprof(["remove", "personal"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`its folder is kept: ${join(home, ".claude-personal")}`);
  expect(Object.keys(savedConfig().profiles)).toEqual(["work"]);
  expect(existsSync(join(home, ".claude-personal/.claude.json"))).toBe(true);
  expect(cprof(["personal"]).code).toBe(2);
});

test("the profile shared folders come from can't be removed", () => {
  const r = cprof(["remove", "work"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("can't be removed");
});

test("list shows each profile's dir and MCP list from profiles.json", () => {
  const r = cprof(["list"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("work (shares its folders)\n  dir: ~/.claude (default)\n  mcp: playwright, tracker");
  expect(r.out).toContain("personal\n  dir: ~/.claude-personal\n  mcp: playwright, stitch");
});

test("mistyped options are rejected instead of ignored", () => {
  expect(cprof(["add", "client", "--mpc", "x"]).err).toContain("unknown option --mpc");
  expect(cprof(["add", "client", "--mcp"]).err).toContain("--mcp needs a value");
  expect(cprof(["edit", "work"]).err).toContain("usage: cprof edit <name> --mcp");
  expect(cprof(["add"]).code).toBe(2);
});

test("a profile at ~ is refused because it would share work's .claude.json", () => {
  const before = readFileSync(configPath, "utf8");
  const r = cprof(["add", "x", "--dir", "~"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('profiles "work" and "x" resolve to the same .claude.json');
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(userMcp(join(home, ".claude.json"))).toEqual(["mystery", "playwright", "stitch", "tracker"]);
  expect(claudeCalls()).toEqual([]);
});

test("an edit that fails partway leaves profiles.json alone, and the same command finishes it", () => {
  cprof(["setup"]);
  const before = readFileSync(configPath, "utf8");
  const failed = cprof(["edit", "work", "--mcp", "-tracker"], { FAKE_CLAUDE_FAIL_MCP: "1" });
  expect(failed.code).toBe(1);
  expect(readFileSync(configPath, "utf8")).toBe(before);

  const retried = cprof(["edit", "work", "--mcp", "-tracker"]);
  expect(retried.code).toBe(0);
  expect(retried.out).toContain("work now has: playwright");
  expect(savedConfig().profiles.work.mcp).toEqual(["playwright"]);
  expect(userMcp(join(home, ".claude.json"))).not.toContain("tracker");
});

test("adding a profile isn't blocked by a problem in another profile", () => {
  mkdirSync(join(home, ".claude-personal/skills/own"), { recursive: true });
  expect(cprof(["setup"]).code).toBe(1);
  const r = cprof(["add", "client"]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain(".claude-personal");
  expect(existsSync(join(home, ".claude-client/skills"))).toBe(true);
});

test("adding a profile doesn't apply unrelated hand edits to other profiles", () => {
  cprof(["setup"]);
  const cfg = savedConfig();
  cfg.profiles.personal.mcp.push("tracker");
  writeFileSync(configPath, JSON.stringify(cfg));
  expect(cprof(["add", "client"]).code).toBe(0);
  expect(userMcp(join(home, ".claude-personal/.claude.json"))).toEqual(["playwright", "stitch"]);
});

test("add with a custom dir creates a working profile there", () => {
  cprof(["setup"]);
  expect(cprof(["add", "client", "--dir", "~/accounts/client"]).code).toBe(0);
  expect(savedConfig().profiles.client.configDir).toBe("~/accounts/client");
  expect(existsSync(join(home, "accounts/client/skills/demo"))).toBe(true);
  writeFileSync(log, "");
  expect(cprof(["client"]).code).toBe(0);
  expect(claudeCalls()).toEqual([{ args: [], configDir: join(home, "accounts/client") }]);
});

test("edit --dry-run and remove --dry-run change nothing", () => {
  cprof(["setup"]);
  const config = readFileSync(configPath, "utf8");
  const work = readFileSync(join(home, ".claude.json"), "utf8");
  writeFileSync(log, "");

  const edit = cprof(["edit", "work", "--mcp", "-tracker", "--dry-run"]);
  expect(edit.code).toBe(0);
  expect(edit.out).toContain("remove MCP server tracker from work");
  const remove = cprof(["remove", "personal", "--dry-run"]);
  expect(remove.code).toBe(0);
  expect(remove.out).toContain("would remove personal from profiles.json");

  expect(readFileSync(configPath, "utf8")).toBe(config);
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(work);
  expect(claudeCalls()).toEqual([]);
});

test("edit and remove name the problem when the profile doesn't exist", () => {
  expect(cprof(["edit", "nope", "--mcp", "+stitch"]).err).toContain('unknown profile "nope"');
  const r = cprof(["remove", "constructor"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown profile "constructor"');
});

test("a server listed twice is added once", () => {
  cprof(["setup"]);
  expect(cprof(["add", "client", "--mcp", "playwright,playwright"]).code).toBe(0);
  expect(savedConfig().profiles.client.mcp).toEqual(["playwright"]);
  expect(claudeCalls().filter((c) => c.args[1] === "add-json" && c.configDir?.endsWith(".claude-client"))).toHaveLength(1);
});

test("rename keeps the profile's folder, login and place, and updates shareFrom", () => {
  cprof(["setup"]);
  expect(cprof(["rename", "personal", "home"]).code).toBe(0);
  expect(cprof(["rename", "work", "job"]).code).toBe(0);

  const saved = savedConfig();
  expect(Object.keys(saved.profiles)).toEqual(["job", "home"]);
  expect(saved.shareFrom).toBe("job");
  expect(saved.profiles.home).toEqual({ configDir: "~/.claude-personal", mcp: ["playwright", "stitch"] });
  writeFileSync(log, "");
  expect(cprof(["home"]).code).toBe(0);
  expect(cprof(["job"]).code).toBe(0);
  expect(claudeCalls()).toEqual([
    { args: [], configDir: join(home, ".claude-personal") },
    { args: [], configDir: null },
  ]);
  expect(cprof(["personal"]).code).toBe(2);
});

test("rename refuses a name that's taken, reserved or unknown, and --dry-run changes nothing", () => {
  const before = readFileSync(configPath, "utf8");
  expect(cprof(["rename", "personal", "work"]).err).toContain('profile "work" already exists');
  expect(cprof(["rename", "personal", "status"]).err).toContain('"status" is a reserved command name');
  expect(cprof(["rename", "nope", "x"]).err).toContain('unknown profile "nope"');
  expect(cprof(["rename", "personal"]).code).toBe(2);
  expect(cprof(["rename", "personal", "home", "--dry-run"]).out).toContain("would rename personal to home");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("re-adding a renamed profile's old name points you to --dir", () => {
  cprof(["setup"]);
  cprof(["rename", "personal", "home"]);
  const r = cprof(["add", "personal"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`${join(home, ".claude-personal")} already belongs to profile "home"; choose another folder with --dir`);
  expect(cprof(["add", "personal", "--dir", "~/.claude-personal2"]).code).toBe(0);
});

describe("without a profiles.json", () => {
  const defaultPath = () => join(home, ".config", "cprof", "profiles.json");

  test("commands point you to cprof init", () => {
    const r = cprof(["status"], { CPROF_CONFIG: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`no profiles yet (${defaultPath()} doesn't exist); run: cprof init`);
    expect(cprof(["help"], { CPROF_CONFIG: undefined }).out).toContain("cprof <profile>");
  });

  test("init creates the config under ~/.config, keeping the MCP servers you already have", () => {
    const r = cprof(["init", "--name", "work"], { CPROF_CONFIG: undefined });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(defaultPath(), "utf8"))).toEqual({
      shareFrom: "work",
      shared: ["skills", "commands", "projects"],
      profiles: { work: { configDir: null, mcp: ["playwright", "tracker", "stitch", "mystery"] } },
    });
    // nothing to change: the default profile keeps all its servers
    expect(cprof(["setup"], { CPROF_CONFIG: undefined }).out).toContain("nothing to do");
  });

  test("init then add gives a second account the same shared setup", () => {
    const env = { CPROF_CONFIG: undefined };
    cprof(["init"], env);
    expect(cprof(["add", "personal", "--mcp", "stitch"], env).code).toBe(0);
    expect(existsSync(join(home, ".claude-personal/skills/demo"))).toBe(true);
    expect(cprof(["list"], env).out).toContain("main (shares its folders)");
  });

  test("init follows XDG_CONFIG_HOME, and won't overwrite an existing config", () => {
    const xdg = join(home, "xdg");
    expect(cprof(["init"], { CPROF_CONFIG: undefined, XDG_CONFIG_HOME: xdg }).code).toBe(0);
    expect(existsSync(join(xdg, "cprof", "profiles.json"))).toBe(true);
    const again = cprof(["init"], { CPROF_CONFIG: undefined, XDG_CONFIG_HOME: xdg });
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
  });

  test("init works on a machine that has never run Claude Code", () => {
    rmSync(join(home, ".claude.json"));
    const r = cprof(["init"], { CPROF_CONFIG: undefined });
    expect(r.code).toBe(0);
    expect(r.out).toContain("MCP: none");
    expect(JSON.parse(readFileSync(defaultPath(), "utf8")).profiles.main).toEqual({ configDir: null, mcp: [] });
  });

  test("init refuses while CLAUDE_CONFIG_DIR is set, and says how to bring that dir in", () => {
    const r = cprof(["init"], { CPROF_CONFIG: undefined, CLAUDE_CONFIG_DIR: join(home, ".claude-main") });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`cprof add <name> --dir ${join(home, ".claude-main")}`);
    expect(existsSync(defaultPath())).toBe(false);
  });

  test("init names the file when ~/.claude.json is malformed", () => {
    writeFileSync(join(home, ".claude.json"), "{ half");
    const r = cprof(["init"], { CPROF_CONFIG: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`cprof: cannot read ${join(home, ".claude.json")}`);
  });

  test("a relative XDG_CONFIG_HOME is ignored, as the XDG spec says", () => {
    expect(cprof(["init"], { CPROF_CONFIG: undefined, XDG_CONFIG_HOME: "relative/cfg" }).code).toBe(0);
    expect(existsSync(defaultPath())).toBe(true);
  });

  test("init --dry-run writes nothing", () => {
    expect(cprof(["init", "--dry-run"], { CPROF_CONFIG: undefined }).out).toContain("would create");
    expect(existsSync(defaultPath())).toBe(false);
  });
});

test("a broken profiles.json is a one-line error, not a stack trace", () => {
  writeFileSync(configPath, "{ nope");
  const r = cprof(["status"]);
  expect(r.code).toBe(1);
  expect(r.err).toStartWith("cprof: cannot read");
  expect(r.err).not.toContain("    at ");
});
