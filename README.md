# cprof

Run [Claude Code](https://docs.claude.com/en/docs/claude-code) under more than one account (say, a work subscription and a personal one) without logging in and out, while every account sees the same skills, slash commands, memory and `CLAUDE.md`.

```bash
cprof work                  # Claude Code on the work account
cprof personal --resume     # extra args go straight to claude
cprof status                # which account each profile is logged into
```

Bare `cprof` never picks an account for you.

## How it works

Claude Code keeps one login per config directory and reads that directory from `CLAUDE_CONFIG_DIR`. cprof gives each account its own directory and starts `claude` with the right one. Inside each extra profile, the folders you choose to share are links back to your main `~/.claude`, so a skill you write or a memory Claude saves shows up in every account.

| | Shared between profiles | Separate per profile |
|---|---|---|
| Skills, slash commands | yes (linked) | |
| Memory and session transcripts (`projects/`) | yes (linked) | |
| `CLAUDE.md` | yes (`@import` of the main one) | |
| Login, `.claude.json` | | yes |
| `settings.json` (hooks, `/model`) | | yes (copied once, then yours to edit) |
| Prompt history | | yes |
| MCP servers | | yes, chosen per profile |

## Install

cprof runs on [Bun](https://bun.sh) (1.1 or newer) and works on Windows, macOS and Linux.

```bash
bun add -g @mqmalagris/cprof
```

## Quick start

```bash
cprof init --name work      # your current Claude Code setup becomes the "work" profile
cprof add personal          # a second profile at ~/.claude-personal
cprof personal              # then run /login with the personal account
cprof status
```

`init` keeps every MCP server you already have on the first profile. Give the new profile its own servers with `--mcp` (names must already exist in some profile), or later with `edit`.

## Commands

```bash
cprof <profile> [claude args...]        # start Claude Code as that profile
cprof init [--name <name>]              # create the config (default name: main)
cprof list                              # profiles, dirs and MCP lists
cprof status                            # logged-in account and live MCP servers per profile
cprof add <name> [--dir <path>] [--mcp a,b]
cprof edit <name> --mcp +a,-b           # add or remove MCP servers
cprof rename <name> <new-name>          # folder and login stay put
cprof remove <name>                     # drops it from the config; folder is kept
cprof setup                             # apply the config to every profile
```

`init`, `add`, `edit`, `rename`, `remove` and `setup` all take `--dry-run`.

- `add` and `edit` show the plan, apply it to that one profile, and only then save the config. If something fails partway, the config is left as it was and running the same command again finishes the job.
- `edit --mcp -name` removes that server from the profile. `setup` is more careful: it only removes a server from a profile when another profile lists it, and leaves servers it doesn't know about alone.
- Before changing a profile's MCP servers, cprof backs up its `.claude.json` next to it as `.claude.json.cprof-backup-<time>`. MCP changes go through `claude mcp add-json` / `claude mcp remove`, never by editing the file directly.

## Configuration

The config lives at `~/.config/cprof/profiles.json` (or `$XDG_CONFIG_HOME/cprof/profiles.json`). Set `CPROF_CONFIG` to use another file. See [`profiles.example.json`](profiles.example.json):

```json
{
  "shareFrom": "work",
  "shared": ["skills", "commands", "projects"],
  "profiles": {
    "work":     { "configDir": null, "mcp": ["playwright", "github"] },
    "personal": { "configDir": "~/.claude-personal", "mcp": ["playwright"] }
  }
}
```

- `configDir: null` means Claude Code's default location (`~/.claude` plus `~/.claude.json`). That profile runs with `CLAUDE_CONFIG_DIR` unset, because setting it to `~/.claude` would make Claude look for `~/.claude/.claude.json` and lose the login. Only one profile can use it.
- `shareFrom` is the profile whose folders the others link to. `shared` lists those folders. Drop `projects` if you don't want accounts to see each other's memory and transcripts.
- Links are junctions on Windows (no admin rights needed) and symlinks elsewhere.

## Things to know

- **Never `rm -rf` a profile folder.** It contains links into your main `~/.claude`, and a recursive delete can follow them. Remove the links first (on Windows, `rmdir <link>`; elsewhere, `rm <link>`), then the folder.
- Run `cprof setup` (or `cprof add`) before the first launch of a new profile. cprof refuses to start a profile whose shared folders aren't linked yet, because Claude would otherwise create real folders in their place.
- Moving a profile to another folder isn't supported: `rename` keeps its folder. To move one, `remove` it, `add` it with the new `--dir`, and log in again.
- If you already export `CLAUDE_CONFIG_DIR` in your shell, unset it before `cprof init`. cprof sets it per profile, and you can bring that folder in with `cprof add <name> --dir <it>`.
- Don't run `/login` with a different account inside an existing profile. The login belongs to that profile's folder.
- IDE extensions and the desktop app don't go through cprof. They stay on whichever account they're logged into.
- On Windows, cprof can't start an npm-installed `claude.cmd` shim. Use the native `claude.exe` installer, or point `CPROF_CLAUDE` at it.
- `cprof status` reads the account email from each profile's `.claude.json`. It's shown in your terminal only.

## Development

```bash
bun install
bun test             # unit and end-to-end tests (the CLI runs against a compiled fake claude)
bun run typecheck
```

## License

[MIT](LICENSE)
