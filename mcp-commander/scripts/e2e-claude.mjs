#!/usr/bin/env node
// Real-client end-to-end test: a headless Claude Code session whose ONLY tools are this server's.
//
// The task needs a SHA-256 of a random nonce, computed inside a Python REPL driven through
// start_process + interact_with_process, written with write_file and found again with
// start_search. Nobody can produce the right digest without the tools actually working, and
// built-in tools are disabled (--tools ""), so a matching file is an unambiguous pass.
//
// The model is verified, not assumed: the init event, every assistant message and the result's
// modelUsage must all name the requested model (a dated snapshot or [context] suffix of the same
// id is accepted). Missing model metadata or any other model is a failure. No fallback model is
// ever passed. The whole run is bounded by --timeout-ms; on timeout Claude's process group is
// terminated.
//
// Usage: node scripts/e2e-claude.mjs [--model claude-opus-5-5] [--timeout-ms 600000] [--keep-work]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = 'claude-opus-5-5';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const model = argValue('--model') ?? DEFAULT_MODEL;
const timeoutMs = Number(argValue('--timeout-ms') ?? 600_000);
const keepWork = process.argv.includes('--keep-work');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
  console.error('--timeout-ms must be an integer >= 1000');
  process.exit(2);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameModel = (actual) =>
  typeof actual === 'string' && new RegExp(`^${escapeRe(model)}(-\\d{8})?(\\[[^\\]]+\\])?$`).test(actual);

const nonce = crypto.randomBytes(16).toString('hex');
const expected = crypto.createHash('sha256').update(nonce).digest('hex');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-claude-e2e-')));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-claude-e2e-config-'));
const mcpConfig = path.join(work, 'mcp.json');
const resultFile = path.join(work, 'result.txt');
const atexitFile = path.join(work, 'atexit.txt');

fs.writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      commander: {
        command: process.execPath,
        args: [path.join(root, 'dist', 'index.js')],
        env: { MCP_COMMANDER_CONFIG_DIR: configDir },
      },
    },
  }),
);

const prompt = [
  'You have only the "commander" MCP tools. Do exactly this, using them:',
  '1. start_process with command "python3 -i -q" (an interactive Python REPL).',
  `2. With interact_with_process, run: import hashlib, atexit; atexit.register(lambda: open("${atexitFile}", "w").write("clean")); print(hashlib.sha256(b"${nonce}").hexdigest())`,
  `3. write_file the printed 64-character hex digest (and nothing else) to ${resultFile}`,
  `4. start_search in ${work} (searchType "content") for the first 12 characters of the digest, to confirm it was saved.`,
  '5. force_terminate the Python process.',
  'Finally reply with one line: DIGEST=<the digest>.',
].join('\n');

const args = [
  '-p', prompt,
  '--model', model,
  // Refuse rather than silently switching models, including content-based fallback.
  '--settings', JSON.stringify({ availableModels: [model], switchModelsOnFlag: false }),
  '--output-format', 'stream-json', '--verbose',
  '--tools', '',
  '--strict-mcp-config', '--mcp-config', mcpConfig,
  '--allowedTools', 'mcp__commander',
  '--setting-sources', 'project',
  '--no-session-persistence',
  '--max-turns', '20',
];

console.log(`[e2e] nonce=${nonce}\n[e2e] expected sha256=${expected}\n[e2e] workdir=${work}\n[e2e] running ${claudeBin} (--model ${model}, timeout ${timeoutMs} ms)...`);
// Allow running this from inside another Claude Code session.
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
// Own process group, so a timeout can stop Claude and everything it started.
const child = spawn(claudeBin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

const killGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
};
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.log(`[e2e] overall timeout (${timeoutMs} ms): terminating Claude's process group`);
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), 5000).unref();
}, timeoutMs);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killGroup('SIGTERM');
    fs.rmSync(configDir, { recursive: true, force: true });
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
    process.exit(130);
  });
}

let buf = '';
let stderr = '';
const toolCalls = [];
const toolErrors = [];
const toolNames = new Map(); // tool_use id -> tool name
let terminateResult = null;
let finalText = '';
let initModel;
const assistantModels = [];
let usageModels = null;
child.stderr.on('data', (d) => (stderr += d));
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      initModel = ev.model;
      const servers = (ev.mcp_servers || []).map((s) => `${s.name}:${s.status}`).join(', ');
      console.log(`[e2e] model (init): ${initModel ?? '(not reported)'}; MCP servers: ${servers}; tools: ${(ev.tools || []).length}`);
    }
    if (ev.type === 'assistant' && ev.message) assistantModels.push(ev.message.model);
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_use') {
        toolCalls.push(block.name);
        toolNames.set(block.id, block.name);
        console.log(`[e2e] → ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
      } else if (block.type === 'tool_result') {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text).join(' ') : String(block.content);
        if (toolNames.get(block.tool_use_id) === 'mcp__commander__force_terminate') {
          terminateResult = text;
          console.log(`[e2e] ← force_terminate: ${text.slice(0, 200)}`);
        }
        if (block.is_error) {
          toolErrors.push(text);
          console.log(`[e2e] ✗ tool error: ${text.slice(0, 200)}`);
        }
      }
    }
    if (ev.type === 'result') {
      finalText = ev.result ?? '';
      if (ev.modelUsage && typeof ev.modelUsage === 'object') usageModels = Object.keys(ev.modelUsage);
    }
  }
});

const code = await new Promise((resolve) => {
  child.on('error', (err) => {
    stderr += `spawn error: ${err.message}`;
    resolve(null);
  });
  child.on('close', resolve);
});
clearTimeout(timer);
killGroup('SIGTERM'); // anything Claude left behind in its group
const saved = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').trim() : null;

const otherModels = [...new Set([initModel, ...assistantModels, ...(usageModels ?? [])].filter((m) => m !== undefined && !sameModel(m)))];
const checks = [
  ['finished within the overall timeout', !timedOut],
  [`model confirmed in init event (${model})`, sameModel(initModel)],
  ['every assistant message reports the requested model', assistantModels.length > 0 && assistantModels.every(sameModel)],
  ['result modelUsage lists only the requested model', usageModels !== null && usageModels.length > 0 && usageModels.every(sameModel)],
  ['claude exited 0', code === 0],
  ['result.txt contains the exact sha256', saved === expected],
  ['final reply contains the digest', finalText.includes(expected)],
  ['used start_process', toolCalls.includes('mcp__commander__start_process')],
  ['used interact_with_process', toolCalls.includes('mcp__commander__interact_with_process')],
  ['used write_file', toolCalls.includes('mcp__commander__write_file')],
  ['used start_search', toolCalls.includes('mcp__commander__start_search')],
  // The REPL catches SIGINT; it must end on EOF (its atexit handler runs), not by SIGTERM/SIGKILL.
  // The reported status is the login shell's, which may be "signal SIGINT" when it is bash.
  [
    'force_terminate let Python exit cleanly',
    terminateResult !== null && !/SIGTERM|SIGKILL/.test(terminateResult) && fs.existsSync(atexitFile),
  ],
  ['only commander tools were used', toolCalls.length > 0 && toolCalls.every((n) => n.startsWith('mcp__commander__'))],
];
console.log('\n[e2e] results:');
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`[e2e] models seen: init=${initModel ?? '-'}; assistant=[${[...new Set(assistantModels)].join(', ')}]; modelUsage=[${(usageModels ?? []).join(', ')}]`);
if (otherModels.length) console.log(`[e2e] MODEL MISMATCH: ${otherModels.join(', ')} (requested ${model}; no fallback allowed)`);
console.log(`[e2e] tool calls (${toolCalls.length}): ${toolCalls.map((n) => n.replace('mcp__commander__', '')).join(', ')}`);
if (toolErrors.length) console.log(`[e2e] tool errors seen: ${toolErrors.length}`);
if (saved !== expected) console.log(`[e2e] saved=${JSON.stringify(saved)}`);
if (code !== 0) console.log(`[e2e] claude result: ${finalText.slice(0, 500)}\n[e2e] stderr:\n${stderr.slice(-2000)}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? '\n[e2e] PASS' : '\n[e2e] FAIL');
fs.rmSync(configDir, { recursive: true, force: true });
if (pass || !keepWork) fs.rmSync(work, { recursive: true, force: true });
else console.log(`[e2e] kept ${work} for inspection`);
process.exit(pass ? 0 : 1);
