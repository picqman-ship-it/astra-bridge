# mcp-commander remote runbook (0.3.0)

How to run mcp-commander for a remote client (e.g. ChatGPT through an outbound tunnel) on a
Mac: setup, service, diagnosis, tests, durable jobs, idempotency keys, trust boundaries,
limitations, snapshots/rollback, and the external steps that have to be done by the owner.

> **Using mcp-commander through Astra Bridge?** The Astra Bridge agent starts mcp-commander's
> `remote-stdio` entrypoint itself, so you can skip the HTTP service and OpenAI Secure MCP Tunnel
> sections (3, 10, 11). Wherever this runbook says a change takes effect on restart, restart the
> Astra Bridge agent (`launchctl kickstart -k gui/$(id -u)/com.example.astra-bridge-agent`).

Paths below use `<repo>` for the directory you cloned mcp-commander into and `<you>` for your
macOS user name. Run every command from `<repo>`.

---

## 1. What exists

| Entrypoint | Transport | Who authenticates | Tools |
|---|---|---|---|
| `dist/index.js` (`mcp-commander`) | stdio | the spawning client (Claude Code / Desktop) | all 27 local tools, **unchanged** (no job tools, no idempotencyKey) |
| `dist/http.js` (`mcp-commander-http`) | Streamable HTTP on `127.0.0.1` | bearer token from an owner-only file | remote policy (below) |
| `dist/remote-stdio.js` (`mcp-commander-remote-stdio`) | stdio | the spawning tunnel client | remote policy (below) |
| `dist/remote/job-worker.js` | none (stdio on /dev/null) | started by the remote servers on demand | runs durable jobs (section 6a) |

Both remote entrypoints read **only** the remote directory (default `~/.mcp-commander-remote`,
override with `--remote-dir <dir>` or `MCP_COMMANDER_REMOTE_DIR`). They never read or write the
local `~/.mcp-commander/config.json`.

### Remote tool policy

* **Always (file-only mode, 15 tools):** `read_file` (local files only — URL fetching is disabled),
  `read_multiple_files`, `write_file`, `create_directory`, `list_directory`, `move_file`,
  `get_file_info`, `edit_block`, `start_search`, `get_more_search_results`, `stop_search`,
  `list_searches`, `get_config` (read-only remote summary), `get_recent_tool_calls`,
  `get_usage_stats`.
* **Only with `"trustedTerminal": true` (27 tools in total):** the 7 terminal/process tools
  `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`,
  `list_sessions`, `list_processes`, `kill_process`, and the 5 durable-job tools `job_start`,
  `job_status`, `job_list`, `job_logs`, `job_cancel`. `start_process` and `job_start` default
  their `cwd` to the first root and refuse a `cwd` outside the roots.
* **Only with `"trustedGui": true` (+4 tools, so 19 or 31):** the macOS GUI tools `list_windows`,
  `inspect_ui`, `press_element`, `set_element_value`. They see and operate every app window of
  your user, not just the roots, and need Accessibility permission for the Node binary that runs
  the service. `remote:setup` never turns this on; set it by hand in `remote.json`.
* **Never:** `set_config_value`. Nothing reachable over MCP can change the remote settings; the
  `jobs`/`idempotency` settings are also file-only.
* **Optional `idempotencyKey`** (remote only) on the mutating tools `write_file`, `edit_block`,
  `move_file`, `create_directory`, and in trusted mode `start_process`, `interact_with_process`,
  `force_terminate`, `kill_process`, and with `trustedGui` `press_element`, `set_element_value`;
  **required** on `job_start` (section 6b).

File and search tools are confined to `roots` with the same symlink-resolving checks the local
server uses (a link inside a root pointing outside is refused).

### Protocol

Ordinary MCP tools over the transports above; this is **not** an implementation of the MCP
Tasks extension (https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)
and no `tasks` capability is advertised. The installed SDK (`@modelcontextprotocol/sdk` 1.30.1)
negotiates protocol versions `2025-11-25` (latest), `2025-06-18`, `2025-03-26`, `2024-11-05` and
`2024-10-07`; each is tested with a real `initialize` handshake. A client asking for any other
version (e.g. `2026-07-28`) is answered with `2025-11-25` and must decide itself whether to
continue; a later request carrying an unsupported `MCP-Protocol-Version` header gets HTTP 400.

---

## 2. Setup (owner, once)

Pick a **dedicated** workspace directory. Roots may not be `/`, the home directory or any
ancestor of it, and may not overlap (be, contain or be inside) `~/.mcp-commander-remote`,
`~/.mcp-commander`, this installation (`<repo>`, so neither it nor any directory that contains
it), Node's prefix (`/usr/local` for Homebrew Node, both via the `node` symlink and
its real path), `~/Library/LaunchAgents`, `~/.ssh`, `~/.claude`, `~/.config` or
`~/.astra-bridge` (the Astra Bridge agent/client Ed25519 private keys). Otherwise a file-only
client could read credentials or rewrite the code or settings the service loads on its next
start.

**Extra protected locations: `MCP_COMMANDER_PROTECTED_PATHS`.** The process that starts
`dist/remote-stdio.js` or `dist/http.js` can protect more directories by setting this variable
in the server's environment: absolute paths separated by `:`, e.g.
`MCP_COMMANDER_PROTECTED_PATHS=/Users/<you>/astra-bridge/relay:/Users/<you>/other`.
The Astra Bridge agent sets it to its own code directory automatically, so a remote client cannot
rewrite `agent.mjs`. Empty entries are ignored; a relative or space-padded entry (including
`~/…`, which is not expanded) stops the server with exit code 78, like any other config error.
Entries are realpath'd, and a location that does not exist yet is protected too. The variable is
read wherever `remote.json` is validated, so each process enforces only what its own environment
lists; use `"protectedPaths"` below for locations every process must enforce.

**Extra protected locations in `remote.json`: `"protectedPaths"`.** The same kind of list can be
stored in the config itself, so that **every** process that loads it (stdio server, HTTP
service, job worker, `remote:doctor`) enforces it without any environment set-up:
`"protectedPaths": ["/Users/<you>/astra-bridge/relay"]` (absolute paths, up to 32; a relative or
space-padded entry is a config error). `remote:setup --protect <dir>` (repeatable) writes it when
it creates or replaces the config. Remote clients can never edit `remote.json`, so they cannot
remove an entry. The environment variable and the config list are merged.

**How roots are compared.** A root is realpath'd with `fs.realpathSync.native`, i.e. stored in
the case and Unicode form the filesystem reports (APFS is case- and normalization-insensitive:
`~/.Astra-Bridge`, `~/.aſtra-bridge` with U+017F, or a decomposed `é` open the same directory
as the on-disk name). Protected locations get the same treatment (the deepest existing ancestor
for one that does not exist yet; symlinks, even dangling ones, are followed). The comparison also
covers the macOS firmlink twin (`/System/Volumes/Data/Users/…` is `/Users/…`, so
`/System/Volumes/Data` and `/System` count as containing the home directory) and device/inode
identity (another mount of the same directory).

```bash
cd <repo>
npm run build
mkdir -p ~/remote-workspace
npm run remote:setup -- --root ~/remote-workspace            # files/search only
# or, to also allow shells/REPLs/process control/jobs (see trust boundaries first):
npm run remote:setup -- --root ~/remote-workspace --trusted-terminal --replace-config
```

This creates, without ever printing the token:

```
~/.mcp-commander-remote/              0700
~/.mcp-commander-remote/token         0600  256-bit random bearer token (base64url, 43 chars)
~/.mcp-commander-remote/remote.json   0600  settings (below)
~/.mcp-commander-remote/logs/         0700  audit.jsonl (+ .1, .2), service.log
~/.mcp-commander-remote/durable/      0700  created on first use: jobs, logs, idempotency records (section 6c)
```

Setup is idempotent: an existing valid token and `remote.json` are kept. `--rotate-token` makes a
new token (restart the service and re-configure clients afterwards). `--replace-config` rewrites
`remote.json` (and drops any `jobs`/`idempotency` overrides you added by hand).

To hand the token to a client without displaying it: `pbcopy < ~/.mcp-commander-remote/token`
(clear the clipboard afterwards). Never put it in a URL, argv or a shared file.

### `remote.json`

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 8765,
  "roots": ["/Users/<you>/remote-workspace"],
  "trustedTerminal": false,
  "allowedOrigins": [],
  "blockedCommands": ["sudo", "…"],
  "defaultShell": "/bin/zsh"
}
```

Optional keys: `trustedGui` (default `false`; section 1), `allowedHosts` (default `["127.0.0.1:<port>", "localhost:<port>"]`),
`fileReadLineLimit`, `fileWriteLineLimit`, `limits`, `audit`, `jobs` and `idempotency`:

| `limits` key | default | range |
|---|---|---|
| `maxBodyBytes` | 4194304 | 1 KiB – 16 MiB |
| `maxSessions` | 16 | 1 – 256 |
| `sessionIdleMs` | 1800000 (30 min) | 1 s – 24 h |
| `maxConnections` | 32 | 1 – 1024 |
| `headersTimeoutMs` | 10000 | 1 s – 120 s (≤ requestTimeoutMs) |
| `requestTimeoutMs` | 60000 | 1 s – 600 s (receiving the request, not the reply) |
| `keepAliveTimeoutMs` | 5000 | 1 s – 120 s |

`audit`: `maxBytes` (default 1 MiB, 16 KiB – 64 MiB) and `maxFiles` (default 3, 1 – 20).

| `jobs` key | default | range | meaning |
|---|---|---|---|
| `maxConcurrent` | 2 | 1 – 16 | jobs running at once; the rest wait queued |
| `maxQueued` | 32 | 1 – 1024 | queued jobs; `job_start` is refused beyond this |
| `maxLogBytes` | 4194304 (4 MiB) | 4 KiB – 256 MiB | stored bytes per job **per stream**; the rest is counted, not stored |
| `defaultTimeoutSec` | 3600 | 1 s – 7 days | timeout when `job_start` gives none (max per job: 7 days) |
| `maxJobRecords` | 1000 | 4 – 100000 | job records on disk; never deleted automatically, new jobs refused when full |
| `workerIdleExitMs` | 30000 | 0.5 s – 24 h | the worker exits after this long with nothing queued/running |

| `idempotency` key | default | range | meaning |
|---|---|---|---|
| `maxKeys` | 10000 | 2 – 1000000 | keys on disk; never deleted automatically, new keys refused when full |
| `maxResultBytes` | 262144 (256 KiB) | 1 KiB – 4 MiB | largest recorded result replayed on retries (larger ones are stored truncated) |

The file is validated strictly and **fails closed**: unknown keys, wrong types, `host` other than
`127.0.0.1`/`::1`, wildcard or path-bearing origins/hosts, missing/empty/over-broad roots, a
directory or file with group/other permission bits, a symlinked config or token, or a weak token
all stop the server (exit code 78) with a message that never contains the token. There is no
unauthenticated mode and no public listener option. Changes take effect on restart (the job worker
re-reads `remote.json` before starting each job).

---

## 3. Run it

Foreground (Ctrl-C stops it and every interactive process it started; durable jobs keep running
in the job worker):

```bash
npm run remote:serve
# [mcp-commander-remote] 0.3.0 listening on http://127.0.0.1:8765/mcp (roots: 1, trustedTerminal: false)
```

### As a LaunchAgent (user-level, no sudo)

```bash
npm run service:print       # show the plist that install would write (no changes)
npm run service:install     # validate config+token, write ~/Library/LaunchAgents/local.mcp-commander.remote.plist,
                            # (re)load it via launchctl bootstrap gui/$UID, wait for /healthz
npm run service:status      # plist present/matching, launchd state + pid, /healthz
npm run service:uninstall   # launchctl bootout (graceful stop), remove plist; config/token/logs are kept
```

The plist uses the absolute Node path of the `node` that ran install (`process.execPath`) and the
absolute `dist/http.js` path, `RunAtLoad`, `KeepAlive` = restart unless it exited successfully,
`ThrottleInterval` 30 s, `ExitTimeOut` 20 s (SIGTERM, then SIGKILL after 20 s), `Umask` 077, an
explicit `PATH` (`<node dir>:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`),
`MCP_COMMANDER_REMOTE_DIR`, and stdout/stderr to `~/.mcp-commander-remote/logs/service.log`
(only lifecycle lines; truncated at startup when over 1 MiB). No secret is in the plist.
`install` is idempotent: re-running it stops the loaded instance gracefully and loads the current
plist. Re-run it after moving the project, changing the Node install or upgrading. The plist is
unchanged in 0.3.0.

If the config is invalid the service exits 78; launchd retries it every 30 s until it is fixed
(one line in `service.log` per attempt). `service:uninstall` stops that.

---

## 4. Doctor

```bash
npm run remote:doctor            # human readable
node dist/remote/doctor.js --json
```

Read-only checks: package vs compiled version, `dist/` freshness vs `src/`, Node path/version,
remote config validity, token file permissions/strength (value never shown), audit log size,
durable state (0700, record/key counts against their limits), job worker (running / unresponsive
/ not running, heartbeat age), LaunchAgent plist + `launchctl print` state, `/healthz`, and an
authenticated MCP handshake that reports the **running** server's version (must equal this build —
otherwise restart the service) and verifies the exposed tool names are **exactly** the configured
set (15 or 27, plus 4 with `trustedGui`; never `set_config_value`; missing/unexpected names are listed). The handshake
creates one MCP session and deletes it. Exit code 1 if any check fails.

---

## 5. Tests

```bash
npm run typecheck
npm test                       # builds, then all unit/integration tests (temp dirs only)
npm run remote:smoke           # independent SDK client against a real dist/http.js child: default mode
                               # (exact 15 names), trusted mode (exact 27 names, REPL, reconnect, restart,
                               # a durable job that survives the restart)
npm run reliability:smoke      # temp-only real HTTP processes: same-key concurrent job_start, job survival
                               # through server SIGKILL + SIGTERM restarts, duplicate appends, replay after
                               # restart; JSON report on stdout, exit 0 only if all checks pass
npm run release:snapshot       # snapshot + manifest (section 9)
node scripts/e2e-claude.mjs    # live Claude Code run; default --model claude-opus-5-5
node scripts/verify-installed.mjs  # against the INSTALLED service (operator, after install; section 11)
```

None of the automated tests touch `~/.mcp-commander-remote`, the LaunchAgent or launchd; every
worker and job they start is stopped afterwards (matched by the temp remote dir / verified PID
identity, never other processes).

The E2E script requires a logged-in `claude` CLI and runs a real model session. It fails unless
the init event, every assistant message and the result's `modelUsage` all report the requested
model (a dated snapshot or `[…]` suffix of the same id is accepted); no fallback model is passed.
`--timeout-ms` (default 600000) bounds the whole run and kills Claude's process group on
expiry; temp dirs are removed (`--keep-work` keeps the work dir on failure).

---

## 6. Sessions and process lifetime (exact semantics)

* `POST /mcp` with an `initialize` request and no `Mcp-Session-Id` creates a session; the id is
  returned in the `Mcp-Session-Id` header. All other requests must carry it.
* The bearer token is checked **before** any session lookup: an unknown session without a valid
  token gets 401, never 404.
* `DELETE /mcp` with the session id closes the session.
* **Idle expiry:** a session with no POST/DELETE activity for `limits.sessionIdleMs` is closed;
  an open `GET` notification stream does not keep it alive. Afterwards its id answers 404 and the
  client must initialize again.
* **Capacity:** at `maxSessions`, a new `initialize` closes the least recently used session with
  no request in flight; if every session is busy the reply is 503 with `Retry-After: 30`.
* **Interactive processes (`start_process`), searches and call history belong to the service,
  not to a session.** Closing, expiring or evicting a session does not stop them; a client that
  reconnects — with the same session id or a brand-new session — reaches a running REPL by its PID.
  They end with `force_terminate` / `stop_search` or when the service stops.
* **Service stop/restart** (SIGTERM, `service:uninstall`, reinstall, logout, reboot) terminates
  every **interactive** process the service started (unchanged from 0.2.0). After a restart all old
  session ids are unknown (404), and earlier interactive processes cannot be resumed.
* **Durable jobs (`job_start`) are not interactive processes** and are not stopped by a service
  stop — see 6a.
* Astra Bridge's `./install-macos.sh uninstall` and permission-reducing setup (`--file-only` or
  `--reconfigure`) explicitly stop tracked durable work as well (`stopDurableJobs` in
  `src/remote/offboarding.ts`). They disable new job submissions, cancel queued work, verify every
  recorded worker and job process (PID + start time) before signalling any of them, and report
  shutdown as unconfirmed, never as done, when something cannot be verified. A job group that
  outlives its verified leader is waited for (SIGKILL after 3.5 s); a group without a verified
  leader is never signalled. A record without a process ID (e.g. `outcome_unknown` after a worker
  crash between intent and start) cannot be verified: inspect it, then move that one job directory
  out of `durable/jobs/` to acknowledge it. Job records are otherwise retained. `--enable-terminal`
  is required to allow new durable jobs after offboarding; cancelled jobs are never resurrected.
  Programs that detached from tracked groups during earlier terminal access require separate
  local inspection.

### 6a. Durable jobs

* `job_start` validates the command (blocklist, including `sh -c`/`$(…)` payloads), the shell and
  the `cwd` (must be a directory inside a root; symlinks resolved) and then records the job as
  `queued` in the private state directory. It returns immediately with a `jobId`.
* Jobs run in **one detached job worker** per remote directory
  (`node dist/remote/job-worker.js --remote-dir …`). The HTTP or remote-stdio server starts it on
  demand with `detached: true`, `stdio: 'ignore'` and `unref()` (see
  https://nodejs.org/api/child_process.html): it gets its own session and process group, is not
  connected to any MCP stream, and is never touched by `TerminalManager.shutdown()`. It keeps
  running — and so do its jobs — when MCP connections drop and when the server exits normally
  or is SIGKILLed (both tested with real processes). A restarted server finds the jobs on disk.
* The worker starts queued jobs oldest first while fewer than `jobs.maxConcurrent` run. Right
  before starting a job it **validates again** against the current `remote.json` (trusted mode
  still on, blocklist, roots, `cwd` still exists and still resolves to the same place — a removed
  directory, an unmounted volume or a directory swapped for a link fails the job as
  "Not started: …"). Then it records `starting` (intent), spawns the job in its own process group
  (`<shell> -l -c <command>`, stdin closed, env plus `MCPC_JOB_ID`), and records `running` with the
  PID and the process identity (process group + start time from `ps`).
* States: `queued` → `starting` → `running` → `succeeded` (exit 0) | `failed` (non-zero exit,
  signal, or not started because revalidation failed) | `cancelled` | `timed_out`; and
  `interrupted` / `outcome_unknown` after a worker death (below). Every record has `createdAt`,
  `startedAt`, `finishedAt`, `elapsedMs`, `exitCode`, `signal`, stored/dropped byte counts per
  stream and `reason` where useful.
* **Progress** is only what the job reports: a stdout line `MCPC_PROGRESS 3/10 message` or
  `MCPC_PROGRESS 40%`. Otherwise `progress` is `null`. No percentage is ever estimated.
* **Logs:** stdout and stderr go to separate files, each capped at `jobs.maxLogBytes`; output after
  the cap is counted (`dropped`) but not stored. The worker holds at most one pipe chunk in memory
  per stream. `job_logs` reads by byte offset (max 64 KiB per call; negative offset = tail).
* **Timeout:** default `jobs.defaultTimeoutSec` (1 h), per job `timeoutSeconds` up to 7 days.
  On timeout or `job_cancel` the worker sends SIGTERM to the job's process group and SIGKILL 3 s
  later.
* **Cancellation:** a queued job is cancelled at once (under the state lock, so the worker cannot
  start it meanwhile). For a starting/running job `job_cancel` writes a durable cancel request
  (`cancel.json`); the worker, which owns the child handle, stops the process group. PIDs from
  records are never signalled blindly.
* **Who starts the worker:** `job_start`, `job_cancel`, and every running remote server (HTTP or
  remote-stdio) itself — at startup and every 2 s while unfinished jobs exist and no live worker
  does. `job_status`, `job_list` and `job_logs` are genuinely read-only and never start anything.
* **Worker death** (crash, `kill -9`, logout, reboot, Mac powered off): a new worker takes over
  only when the old worker's heartbeat is older than 5 s **and** it is *confirmed* gone (its PID
  does not exist or now belongs to a different process — PID + start time). A worker that is
  stopped, on a sleeping Mac, or whose identity cannot be checked (e.g. `ps` failed) is reported
  `unresponsive` and never replaced, so two workers never run the same queue. It
  marks jobs that were `running` as **`interrupted`** and jobs that were `starting` as
  **`outcome_unknown`**. **Neither is resumed or re-run automatically** — an arbitrary command
  cannot be resumed, and re-running it could repeat its side effects. If the interrupted job's PID
  is still in use and not confirmed to be a different process, the record says
  `processMayStillRun: true`; `job_cancel` sends SIGTERM to that process group only after
  confirming the identity (same PID and start time) — an unconfirmable PID is never signalled.
  **Queued jobs stay queued** and run when a worker runs again; they are never lost at server exit.
* The worker stops itself after `jobs.workerIdleExitMs` with nothing queued or running. If it
  receives SIGTERM/SIGINT (e.g. at logout) it stops its running jobs, records them `interrupted`
  and exits; queued jobs stay queued.
* **Reboot:** jobs that were running are `interrupted` when a server next starts (after login).
  Nothing survives a reboot except the records.
* **launchd:** the worker is outside the service's process group, which is what launchd signals
  when the service stops. This was verified only with test servers in temp directories, **not**
  with the real LaunchAgent — see section 11 for the operator check.

### 6b. Idempotency keys — what a key does and does not guarantee

* **`job_start` requires `idempotencyKey`.** The key is claimed on disk (atomic create-only
  link, serialized across all server processes of this remote directory) **before** anything else
  happens, together with a fingerprint of the normalized request (command, cwd as an absolute path
  with the first root as default, shell after defaults, timeout, label — normalized without touching
  the filesystem). The same key with the same request returns the **same job** — to concurrent
  clients, after reconnects, from a freshly started server process, and even after the job's cwd
  has disappeared (all tested). A request is validated only when its key is new. The same key with
  a different request is refused. If a server dies between claiming the key and writing the job
  record, a retry reports `never_started` ("nothing was started and nothing will be") — it does not
  start a second job.
* **Other mutating tools accept an optional `idempotencyKey`.** With a key: claim with fingerprint
  of tool + canonical arguments (the key itself excluded; defaults applied, so an omitted default
  equals the explicit value) and state `pending` → run the tool → record the result (bounded to
  `idempotency.maxResultBytes`). A retry with the same key and arguments gets the recorded result
  replayed with a note that the action was **not executed again**. Different arguments or another
  tool with the same key: refused, nothing executed.
* **Pending / uncertain:** if the first call is executing right now in the same server process, a
  retry says "still in progress". In every other pending case — its server process died between
  acting and recording (tested with a real SIGKILL at exactly that moment), the result could not be
  written (e.g. disk full), or another process holds it — a retry answers **"Outcome unknown … NOT
  executed again"** — it never reruns automatically. Check the target yourself, then use a new key.
* **A replay is history, not status:** it shows the result recorded at the first call (marked as
  such). A replayed `start_process` result, for example, does not mean that process still runs.
* **Without a key there is no duplicate protection** (unchanged 0.2.0 behaviour; tested).
* Keys are 8–200 visible ASCII characters; use a fresh UUID per intended action. They are stored
  only as SHA-256 hashes. Keys are **never deleted or reused automatically**; when
  `idempotency.maxKeys` (or `jobs.maxJobRecords`) is reached, new keys/jobs are refused with a clear
  message until the owner archives old records (section 6d).
* **Not promised:** exactly-once side effects of arbitrary shell commands across machine or worker
  failure. What is guaranteed is at-most-once *starting* per key; a started command that was
  interrupted may have done part of its work.

### 6c. Private state and failure behaviour

```
~/.mcp-commander-remote/durable/            0700  (inside the 0700 remote dir, outside every root)
  lock  (lock.break)                        cross-process state lock (see below)
  worker.json  worker.log                   worker pid/identity/heartbeat; worker diagnostics (≤1 MiB)
  jobs/<jobId>/job.json                     job record (includes the command)
  jobs/<jobId>/stdout.log  stderr.log       job output (each ≤ jobs.maxLogBytes)
  jobs/<jobId>/cancel.json                  durable cancel request
  active/<jobId>                            marker: job not finished
  jobkeys/<sha256(key)>.json                job_start key claim → jobId
  idem/<sha256(key)>.json                   idempotency record (fingerprint, state, bounded result)
```

All files are written completely (short writes continued) to an exclusive 0600 temp file, fsynced
and renamed (or hard-linked for create-only claims), and the directory is fsynced; a directory
fsync error other than "unsupported by this filesystem" is a failure, and a claim that could not be
made durable is taken back before anything runs. Readers refuse symlinks, non-regular files, files
of other owners and files with any group/other permission bit; job ids are validated against a
strict pattern before they are used in a path. Malformed records, unwritable directories (EACCES),
a full disk (ENOSPC), I/O errors (EIO) or a full store make the call **fail closed before acting**
— tested by injecting each (and short writes).

**The state lock** holds its owner's PID, process identity and a nonce, and is created complete in
one step. It is taken from an owner only when that owner is *confirmed* gone (PID absent, or the
PID now belongs to another process). A live owner is never robbed however long it holds the lock;
an owner whose identity cannot be confirmed and a malformed lock file are never broken
automatically — callers time out after 10 s with an error naming the file, and nothing is done.
Concurrent breakers are serialized through `lock.break`. `idem/` contains tool results (e.g. file contents
returned by `edit_block` previews) and `jobs/` contains commands and output: treat the directory as
private. The audit log never gets arguments, keys, commands or results.

### 6d. Manual recovery (owner, on the Mac)

```bash
D=~/.mcp-commander-remote/durable
cat $D/worker.json; tail -n 50 $D/worker.log             # worker pid/heartbeat, diagnostics
ls $D/active                                              # unfinished jobs
cat $D/jobs/<jobId>/job.json                              # one job record
```

* **Stuck state lock** (every job/idempotency call fails with "Timed out waiting for the state
  lock … remove … manually"): `cat $D/lock` shows the owner PID. If that PID is not an
  mcp-commander server or job worker (`ps -o command= -p <pid>`), or nothing of mcp-commander runs
  at all, remove `$D/lock` and `$D/lock.break`. Never remove it while the owner still runs.
* **Stop the worker** (running jobs become `interrupted`, queued jobs stay queued): check
  `ps -o command= -p <pid>` shows `job-worker.js`, then `kill -TERM <pid>`.
* **Interrupted / outcome_unknown job:** inspect what it did (its logs, the files it touches).
  It is never restarted automatically, and you should not restart a destructive job blindly. To
  run it again deliberately, submit it with a **new** key.
* **Leftover process of an interrupted job:** `job_cancel` (identity-checked), or compare
  `ps -o pgid=,lstart= -p <pid>` (with `TZ=UTC LC_ALL=C`) with `pidIdentity` in the record before
  signalling it yourself.
* **Unreadable record** (job_start refuses while an unfinished job record is malformed; job_list
  shows it as `unreadable`): stop the worker, move `jobs/<jobId>` and `active/<jobId>` out of
  `durable/` for inspection.
* **Store full / archiving:** only while no worker runs (`worker.json` absent) and only finished
  jobs: move `jobs/<jobId>` directories to an archive outside `durable/` (keep it private). Keep
  their `jobkeys/` entries: a retry with such a key then reports `never_started` instead of running
  again. Deleting a `jobkeys/…` or `idem/…` file **re-enables that key** — a client retrying with
  it would execute again. Only delete keys no client will retry.
* Never copy `durable/` into a project or release; the snapshot script excludes it anyway.

---

## 7. Trust boundaries — read before enabling anything

* **The token is the whole credential.** Anyone who has it (or controls a client configured with
  it, e.g. the ChatGPT account connected through the tunnel) can read, write, move and search
  everything under the roots, and read the in-memory call history.
* **`trustedTerminal: true` is arbitrary code execution as your macOS user**, now also through
  durable jobs that outlive the connection and the service process. `blockedCommands` is a guard
  rail, not a sandbox: `python3 -c`, `node -e`, scripts, etc. can do anything you can, including
  reading files outside the roots, your keychain-accessible data, changing `remote.json` and the
  durable state. The roots do **not** constrain shells, interpreters or jobs. No sandbox exists.
* **Writes inside a root can become code execution later** if you run things from there (project
  scripts, git hooks, `npm install`). Use a dedicated workspace, not your projects. The
  protected-location list (section 2) blocks the known self-modification paths — this
  installation, Node's prefix, launchd agents, both config dirs, `~/.astra-bridge` and whatever
  `MCP_COMMANDER_PROTECTED_PATHS` lists — but it is not exhaustive. It is checked when
  `remote.json` is loaded; a hard link to a protected file that something else places inside a
  root is not detected.
* **Secret files are checked at open time**, not just by path: the token/config file must be a
  regular, non-symlink, owner-only file both before and after it is opened (same inode). This
  does not protect against malicious code already running as your user.
* **Loopback only.** The listener is `127.0.0.1`. Other local processes can connect but need the
  token; other macOS users cannot read the 0600 token. Malware already running as you is out of
  scope (it could read the token or the files directly).
* **Browsers:** requests with an `Origin` header are refused unless that exact origin is listed;
  there are no CORS headers at all. The Host header must be in `allowedHosts` (DNS-rebinding
  defense).
* **Health:** `GET /healthz` is unauthenticated and returns only `{"status":"ok"}` (or
  `stopping`). No version, paths, tokens or process data.
* **Audit log** (`logs/audit.jsonl`): time, event, tool name, ok/error/denied, duration, and a
  12-hex hash of the session id. Never arguments, keys, results, paths, headers or tokens. Bounded
  by rotation. It is not tamper-proof: your user can edit it.
* **Remote party visibility:** tool traffic passes through the tunnel provider and the model
  provider. Do not put secrets in the roots.

---

## 8. Mac sleep, login and network limitations

* The LaunchAgent lives in the `gui/<uid>` domain: it starts when you log in and stops when you
  log out. After a reboot nothing runs until you log in (with FileVault, until you unlock the
  disk at login).
* While the Mac sleeps, the service, the job worker, its jobs and any tunnel are suspended; remote
  calls fail and job timeouts keep counting wall-clock time. This project does not change energy
  settings. If wanted, the owner can choose System Settings › Battery/Energy options or run
  `caffeinate -s` while on power.
* Network changes drop outbound tunnel connections; the tunnel client must reconnect by itself.
* Interactive REPLs/processes started remotely die with the service (logout, reboot, reinstall,
  crash restart). Durable jobs survive service restarts but not logout/reboot (they become
  `interrupted`). Neither can be resumed.
* No long soak test (hours/days) has been run; tests and smoke runs take seconds to minutes.

---

## 9. Snapshots and rollback

```bash
npm run build && npm test
npm run release:snapshot
# [release] …/release/mcp-commander-0.3.0-<UTC>.tar.gz
# [release] sha256 …
```

The archive contains `src/`, `native/`, `dist/`, `test/`, `scripts/`, `docs/`, `package.json`,
`package-lock.json`, `tsconfig.json`, `README.md`, `LICENSE`, `.gitignore`, plus `MANIFEST.sha256` (one
SHA-256 per file) and `SNAPSHOT.json`. Excluded: `node_modules/`, `release/`, `.analysis/`,
symlinks, token files, `remote.json`, keys, `.env*`, `*.log`, `*.jsonl`, and any copy of durable
state (`durable/`, `jobs/j…`, `jobkeys/…`, `idem/…`, `active/…`, `job.json`, `worker.json`,
`cancel.json`) — live job metadata, commands, logs and idempotency results never ship. Packaging
aborts if any file contains the live remote token or a private-key/API-key pattern. **A snapshot is
a copy of the working tree at one moment — it is not Git history.**

Verify and roll back:

```bash
cd release
shasum -a 256 -c mcp-commander-0.3.0-<UTC>.tar.gz.sha256
mkdir -p ~/mcp-commander-rollback && tar -xzf mcp-commander-0.3.0-<UTC>.tar.gz -C ~/mcp-commander-rollback
cd ~/mcp-commander-rollback/mcp-commander-0.3.0 && shasum -a 256 -c MANIFEST.sha256
npm ci                      # dependencies from the lockfile (network)
npm test
# point the service at this copy:
npm run service:install     # rewrites the plist with this copy's dist/http.js and reloads
# local Claude clients: re-point their MCP config to this copy's dist/index.js
```

Rolling back does not touch `~/.mcp-commander-remote` (config/token/durable state) or
`~/.mcp-commander`. **Rolling back from 0.3.0 to 0.2.0:** first make sure no job is queued or
running (`job_list`, or `ls ~/.mcp-commander-remote/durable/active` is empty) and no worker runs
(`worker.json` absent) — 0.2.0 has no job tools and would leave queued jobs unstarted and a running
worker unsupervised by any server. Remove any `jobs`/`idempotency` keys from `remote.json` (0.2.0
rejects unknown keys and would refuse to start). The `durable/` directory can stay; 0.2.0 ignores
it. Rolling back to 0.1.0 (no HTTP entrypoint): `npm run service:uninstall` first.

---

## 10. External step: OpenAI Secure MCP Tunnel

Official guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

This project does not install, configure or start a tunnel client; follow the guide for the
tunnel client's own commands. Nothing is reachable from outside the Mac until you do.

What to give the tunnel client — choose one:

**A. stdio (simplest; no bearer token needed because the tunnel client spawns the process):**

```
command: <absolute path of node, e.g. the output of `command -v node`>
args:    ["<repo>/dist/remote-stdio.js",
          "--remote-dir", "/Users/<you>/.mcp-commander-remote"]
```

Use absolute paths (a spawning client does not expand `~`). `--remote-dir` may be omitted when
it is the default `~/.mcp-commander-remote`.

remote-stdio shares the same durable state and idempotency records as the HTTP service (tested):
a job started through one is visible and deduplicated through the other.

**B. HTTP (the LaunchAgent service):** only if the tunnel client can send a custom
`Authorization` header to the local target.

```
URL:     http://127.0.0.1:8765/mcp
Header:  Authorization: Bearer <contents of ~/.mcp-commander-remote/token>
Host:    127.0.0.1:8765   (add any other Host value the tunnel sends to "allowedHosts")
Origin:  none expected    (if the tunnel sends one, add that exact origin to "allowedOrigins")
```

Template of values the owner must obtain (keep them out of this project directory):

```
TUNNEL_ID=<from the OpenAI Platform tunnel page>
RUNTIME_API_KEY=<created by the owner in the Platform; store in Keychain or a 0600 file>
ORG/WORKSPACE=<with tunnel + developer-mode access>
```

Then: start the tunnel client per the guide → in ChatGPT enable developer mode and add the
tunnel-backed connector → run `get_config` from ChatGPT (it must report `"mode": "remote"` and
your roots) → check `~/.mcp-commander-remote/logs/audit.jsonl` shows the call → only then try
the iPhone app.

---

## 11. Installing or upgrading the service (operator checklist)

1. `npm ci && npm run typecheck && npm test && npm run remote:smoke && npm run reliability:smoke`
   — all exit 0.
2. `npm run service:install` — (re)loads the LaunchAgent with this build's `dist/http.js`
   (interactive REPLs of a previously running service are stopped by the reload; durable jobs run
   in the separate job worker, which step 5 checks).
3. `npm run remote:doctor` — no FAIL; "running version" equals this build; "exposed tools" 15
   (file-only) or 27 (trusted), plus 4 with `trustedGui`.
4. `node scripts/verify-installed.mjs` (trusted-terminal mode; it starts a Python REPL) — writes
   `docs/installed-service-verification-<version>.json` (kept out of version control by
   `.gitignore`). It uses a throwaway directory in the first root and one idempotency key; it
   starts no durable job.
5. Optional launchd survival check with a harmless job: start `job_start` with command
   `sleep 60`, run `launchctl kickstart -k gui/$UID/local.mcp-commander.remote`, then
   `job_status` must still show `running`, later `succeeded`.
