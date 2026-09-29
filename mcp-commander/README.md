# mcp-commander

A lean MCP server that gives an AI assistant a terminal, long-running process sessions, file
tools with line-based paging, surgical text edits, ripgrep search and (on macOS) semantic
Accessibility control of app windows. It is an independent reimplementation of
[Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP)'s core ideas; the
fuzzy-search algorithm and several message formats follow Desktop Commander (MIT) — see
[LICENSE](LICENSE). It has no telemetry.

## How it works

The client (Claude Desktop, Claude Code, …) starts `node dist/index.js` as a child process and
talks JSON-RPC over stdin/stdout (MCP stdio transport). Every tool call becomes a real action on
this machine and returns text the model reads. Failures are returned as `isError` results with an
`Error: …` message, never as protocol errors, so the model can read them and correct itself.

```
Claude ──stdin──▶ mcp-commander ──spawn──▶ zsh -l -c "npm test"   (sessions by PID)
       ◀─stdout── (MCP server)  ──fs─────▶ files                   (allowedDirectories)
                                ──spawn──▶ ripgrep / built-in walker
                                ──spawn──▶ dist/native/mcp-commander-ax (macOS Accessibility)
```

A second, restricted entrypoint for remote clients (HTTP on loopback with a bearer token) is
described under [Remote access](#remote-access-030).

## Tools (27)

| Group | Tools |
|---|---|
| Config | `get_config`, `set_config_value` |
| Files | `read_file` (offset/length, negative offset = tail, images, URLs), `read_multiple_files`, `write_file` (rewrite/append, chunking), `create_directory`, `list_directory`, `move_file`, `get_file_info` |
| Search | `start_search` (file names or content, ripgrep with a built-in fallback), `get_more_search_results`, `stop_search`, `list_searches` |
| Edit | `edit_block` (exact replace with occurrence count; fuzzy "did you mean" diff when not found) |
| Terminal | `start_process`, `read_process_output`, `interact_with_process` (drive REPLs/shells), `force_terminate`, `list_sessions` |
| Processes | `list_processes`, `kill_process` |
| History | `get_recent_tool_calls`, `get_usage_stats` |
| GUI (macOS only) | `list_windows`, `inspect_ui`, `press_element`, `set_element_value` (Accessibility API: elements are found by role/name/ref and pressed or set semantically, never by coordinates; password fields are never read or set) |

## Install

```bash
cd /path/to/mcp-commander && npm install && npm run build
```

`npm run build` compiles the TypeScript and, on macOS, the small Swift Accessibility helper
(`native/ax-helper.swift` → `dist/native/mcp-commander-ax`). Without the Xcode Command Line Tools
(`xcode-select --install`) the build only warns and the GUI tools report the helper as missing;
everything else works. The GUI tools also need Accessibility permission for the app that starts
the server (System Settings › Privacy & Security › Accessibility).

**Claude Code:**

```bash
claude mcp add commander -- node /path/to/mcp-commander/dist/index.js
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`
under `"mcpServers"` and restart the app:

```json
"commander": {
  "command": "node",
  "args": ["/path/to/mcp-commander/dist/index.js"]
}
```

## Configuration

`~/.mcp-commander/config.json` (override with `--config-dir <dir>` or
`MCP_COMMANDER_CONFIG_DIR`). Edits are picked up on the next tool call.

| Key | Default | Meaning |
|---|---|---|
| `blockedCommands` | 33 commands (`sudo`, `dd`, `mkfs`, `shutdown`, …) | refused by `start_process` / shell `interact_with_process` |
| `allowedDirectories` | `[]` (= everything) | directories the file and search tools may touch |
| `defaultShell` | `$SHELL` | shell for `start_process` |
| `fileReadLineLimit` | `1000` | default lines per read (files and terminal output) |
| `fileWriteLineLimit` | `50` | writes/edits above this get a "write in chunks" hint |

`MCP_COMMANDER_RG=none` forces the built-in search engine; `MCP_COMMANDER_RG=/path/to/rg` picks a ripgrep binary.

### Configuration failure safety

Malformed JSON, non-object config roots, invalid security field types, or an unreadable/uncreatable
config location block new MCP work. `get_config`, session/search diagnostics, output reads and
cleanup remain available. `set_config_value` cannot remove this lockout from inside the model.
Repair or recreate the config file directly with intentional security settings, or restart with a
writable `--config-dir`. Deleting a corrupt config does not silently unlock the server.
Non-security preference values may still use documented defaults. With valid settings, an empty
`allowedDirectories` list still means unrestricted filesystem access. This is not an OS sandbox;
terminal interpreters still run as the user. Work already running is not retroactively sandboxed.

Changes to compiled code apply to newly started MCP processes. An already-open Claude session
must reconnect/restart its MCP server before it uses a new build; do not interrupt active jobs.

## Security model — read this

This server executes whatever commands the model sends, as your user. The guard rails are:

* `blockedCommands` — the command line is tokenized like a shell would (quotes, escapes,
  `$(…)`, backticks, subshells, `sh -c` payloads, `eval`, wrappers like `env`/`nice`/`xargs`/`timeout`,
  newlines), so `bash -c "sudo x"`, `s''udo`, `\sudo` or `nice sudo` are all refused. Input sent to an
  interactive shell session is checked too. An interpreter (`python3 -c "os.system(...)"`) can still
  run anything: it is a guard rail, not a sandbox.
* `allowedDirectories` — enforced for file and search tools after resolving symlinks (a link
  inside an allowed dir that points outside is refused). The terminal is **not** restricted by it.
* The GUI tools see and operate every app window of your user (not limited to
  `allowedDirectories`); a pressed button can do anything the app can. They work only after you
  grant Accessibility permission; the server never bypasses it.
* The model can change the config with `set_config_value`; the tool description tells it to do so
  only when you ask.

No telemetry, no network calls except `read_file` on an `http(s)` URL. Call history is kept in
memory only, with long arguments truncated.

## Differences from Desktop Commander

Fixed: lost terminal output after a read, `exit` vs `close` output truncation, split UTF-8
characters, over-eager prompt detection, `interact_with_process` not noticing process exit,
output "cleanup" that deleted lines starting with `>`/`+`, orphaned child processes (sessions run
in their own process group and are killed on shutdown), `force_terminate` SIGKILLing every REPL and
interactive shell (they catch SIGINT; now stdin is closed and SIGTERM tried first, so they exit
cleanly), jobs of a job-control shell (`sh -i` / `bash -i` on macOS put each in its own process
group) surviving `force_terminate` and shutdown, `read_file` ignoring `fileReadLineLimit`,
overlapping-match miscount in `edit_block`, failed edits reported as success, `maxResults` being
per-file, `filePattern` widening instead of narrowing file searches, regex errors shown as
"No matches found", base64-decoding of `.svg` writes, `/tmp` vs `/private/tmp` denial, trivial
blocklist bypasses. Added: `cwd` for `start_process`, exit codes in `start_process`, full matched
lines in content search, a search fallback when ripgrep is missing, a warning listing unsupported
parameters, semantic macOS GUI tools. Dropped: telemetry, feature flags, onboarding prompts,
PDF/Excel/DOCX handlers, `node:local` execution.

## Remote access (0.3.0)

A separate entrypoint serves a restricted tool set over MCP Streamable HTTP for remote clients
(e.g. ChatGPT through an outbound tunnel). The stdio server above is unchanged (27 tools).

* `dist/http.js` listens on `127.0.0.1` only (`/mcp`, plus a minimal `/healthz`), requires a
  256-bit bearer token read once at startup from an owner-only file and checked on every MCP request, and enforces Host/Origin
  allowlists, body/connection/session limits and timeouts. No unauthenticated mode, no CORS.
* `dist/remote-stdio.js` serves the same restricted tool set over stdio for a tunnel client that
  spawns MCP servers.
* Remote settings live in `~/.mcp-commander-remote/remote.json` (separate from
  `~/.mcp-commander/config.json`), are validated strictly and cannot be changed over MCP.
  File/search tools are confined to explicit `roots`; `set_config_value` is never exposed; shell
  and process tools exist only in an explicit `trustedTerminal` mode, which is arbitrary code
  execution as your user (the roots do not sandbox it). The GUI tools exist only with
  `"trustedGui": true` (set by hand in `remote.json`); they operate any app window of your user,
  not just the roots.
* A root may not be, contain or be inside a protected location: both config dirs, this
  installation, Node's prefix, `~/Library/LaunchAgents`, `~/.ssh`, `~/.claude`, `~/.config` and
  `~/.astra-bridge` (the Astra Bridge agent/client private keys). A process that spawns the server
  adds its own locations, e.g. its code directory, with `MCP_COMMANDER_PROTECTED_PATHS`
  (absolute paths separated by `:`); locations that every loader must enforce go in
  `remote.json` as `"protectedPaths"` (`remote:setup --protect <dir>`). Roots and protected
  locations are compared in the spelling the filesystem reports (`realpath`, on-disk case and
  Unicode form), through macOS firmlinks (`/System/Volumes/Data/...`) and by device/inode, so
  case variants, symlinks or another path to the same directory do not get around the check.
* Terminal sessions/REPLs belong to the service, so they survive reconnects and new MCP sessions,
  and are stopped when the service stops. A bounded audit log records tool name, time, status and
  duration only.
* Remote tool counts: 15 in file-only mode; 27 with `trustedTerminal` (7 terminal/process tools
  and 5 durable-job tools); 4 more with `trustedGui` (19 or 31). `set_config_value` is never
  exposed.
* **Durable jobs (trusted mode only):** `job_start` / `job_status` / `job_list` /
  `job_logs` / `job_cancel`. A job runs in a separate detached worker process, so it keeps running
  when the MCP connection drops or the server restarts (including SIGKILL). `job_start` requires
  an `idempotencyKey`: retries return the same job, never a second one. Bounded concurrency (2),
  queue (32) and logs (4 MiB per stream); progress only if the job prints `MCPC_PROGRESS …`. If
  the worker itself dies (crash, logout, reboot) a running job becomes `interrupted` (or
  `outcome_unknown`) and is **never re-run automatically**.
* **Optional `idempotencyKey`** on remote mutating tools (`write_file`, `edit_block`,
  `move_file`, `create_directory`, `start_process`, `interact_with_process`, `force_terminate`,
  `kill_process`, and with `trustedGui` `press_element`, `set_element_value`): a retry with the same key replays the recorded result instead of acting twice;
  after a crash between acting and recording it reports "outcome unknown" and does not rerun.
  Calls without a key have no duplicate protection. Exactly-once side effects of arbitrary
  commands across machine failure are not promised.
* Job records, logs and idempotency results live in `~/.mcp-commander-remote/durable/` (0700,
  outside every root, never packaged). Nothing is deleted automatically; full stores refuse new
  work clearly. This uses ordinary MCP tools, not the MCP Tasks extension.

```bash
npm run remote:setup -- --root ~/remote-workspace   # 0700 dir, 0600 token + config; token never printed
npm run remote:serve                                # foreground
npm run service:install                             # or: user LaunchAgent (no sudo); status / uninstall
npm run remote:doctor                               # versions, config, token perms, service, health, live handshake
```

Full instructions, session and job semantics, idempotency guarantees and limits, storage limits,
manual recovery, trust boundaries, Mac sleep/login limits, snapshots/rollback and the OpenAI
Secure MCP Tunnel step: [docs/remote-runbook.md](docs/remote-runbook.md).

## Tests

```bash
npm test                              # unit + in-memory MCP client + real stdio and HTTP servers
npm run remote:smoke                  # independent SDK client against a real dist/http.js
npm run reliability:smoke             # temp-only: job survival across server kill/restart, duplicate writes (JSON report)
npm run gui:smoke                     # macOS: reversible GUI tool run against a temp file in TextEdit (needs Accessibility permission)
node scripts/e2e-claude.mjs           # a real headless Claude session driving the server
```

The E2E script gives Claude only this server's tools and asks it to compute a SHA-256 of a random
nonce in a Python REPL, save it with `write_file` and find it with `start_search`; a matching
digest on disk is an unambiguous pass; `force_terminate` must let the REPL exit on its own (its
`atexit` handler runs), not SIGTERM/SIGKILL it. It needs a logged-in `claude` CLI. The default
model is `claude-opus-5-5`; the run fails unless the returned event metadata confirms that model
(no fallback), and `--timeout-ms` bounds it.

## License

MIT — see [LICENSE](LICENSE). Portions are derived from Desktop Commander MCP (MIT); LICENSE lists
them and carries its copyright notice.
