// Compiled into a stand-in `claude` binary for the CLI tests. It records how it was called and
// applies `claude mcp add-json/remove -s user` to the same .claude.json the real CLI would.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
appendFileSync(process.env.FAKE_CLAUDE_LOG!, `${JSON.stringify({ args, configDir })}\n`);

if (args[0] === "mcp") {
  if (process.env.FAKE_CLAUDE_FAIL_MCP) process.exit(3);
  const file = configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  data.mcpServers ??= {};
  const [, sub, , , name, json] = args; // mcp <sub> -s user <name> [json]
  if (sub === "add-json") data.mcpServers[name] = JSON.parse(json);
  else delete data.mcpServers[name];
  writeFileSync(file, JSON.stringify(data));
}

process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
