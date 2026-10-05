import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";

export const config: Config = {
  shareFrom: "work",
  shared: ["skills", "commands", "projects"],
  profiles: {
    work: { configDir: null, mcp: ["playwright", "tracker"] },
    personal: { configDir: "~/.claude-personal", mcp: ["playwright", "stitch"] },
  },
};

/** A home dir laid out like a real one: ~/.claude with shared folders, ~/.claude.json with a login and MCP servers. */
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "cprof-"));
  const base = join(home, ".claude");
  for (const d of ["skills/demo", "commands", "projects/mem"]) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, "skills/demo/SKILL.md"), "demo");
  writeFileSync(join(base, "CLAUDE.md"), "# shared rules");
  writeFileSync(join(base, "settings.json"), '{"model":"opus"}');
  writeFileSync(join(base, "history.jsonl"), "");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "me@work.example" },
      mcpServers: {
        playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp"] },
        tracker: { type: "http", url: "https://tracker.example/mcp" },
        stitch: { type: "http", url: "https://stitch.example/mcp" },
        mystery: { type: "http", url: "https://unlisted.example/mcp" },
      },
    }),
  );
  return home;
}
