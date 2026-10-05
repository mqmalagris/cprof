# cprof

- Validate every path a profile resolves to (its dir *and* its `.claude.json`) and reject collisions between profiles in `resolveProfiles`, not only the configured value. A profile that shares another's `.claude.json` shares its login and undoes its MCP changes.
- Run `bun test` and `bun run typecheck` before committing; CI runs both on Windows, macOS and Linux. CLI behavior is tested end to end in `test/cli.test.ts` against a compiled fake `claude`; keep new commands covered there.
