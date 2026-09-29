#!/usr/bin/env node
// Live, reversible smoke test of the macOS GUI tools against TextEdit, through a real MCP client
// and server (in-process) and the real Accessibility helper. No coordinates anywhere.
//
//  1. writes a throwaway .txt in a fresh temp directory and opens it in TextEdit (in the background)
//  2. list_windows finds that window; inspect_ui finds its text area semantically (role)
//  3. set_element_value changes the text (verified by read-back), inspect_ui confirms it,
//     set_element_value restores the original text (verified)
//  4. press_element presses the window's close button (AXPress) and checks the window is gone
//  5. deletes the temp directory; quits TextEdit only if this script launched it
//
// Never touches other documents or user files. Exit code: 0 pass, 1 fail, 2 blocked (not macOS,
// helper not built, Accessibility permission missing, screen locked).
// Usage: node scripts/gui-smoke.mjs [--out result.json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx === -1 ? null : path.resolve(process.argv[outIdx + 1]);
const steps = [];
const started = new Date().toISOString();
const log = (msg) => process.stderr.write(`[gui-smoke] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, status, detail = '') {
  steps.push({ name, status, detail });
  log(`${status.toUpperCase().padEnd(7)} ${name}${detail ? ` — ${detail}` : ''}`);
}

function finish(code) {
  const result = { started, finished: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, outcome: ['pass', 'fail', 'blocked'][code], steps };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
}

if (process.platform !== 'darwin') {
  record('platform', 'blocked', `macOS only (this is ${process.platform})`);
  finish(2);
}
const helper = path.join(dist, 'native', 'mcp-commander-ax');
if (!fs.existsSync(helper)) {
  record('helper', 'blocked', `${helper} missing: run npm run build (needs Xcode Command Line Tools)`);
  finish(2);
}
const check = JSON.parse(spawnSync(helper, ['check'], { input: '{}', encoding: 'utf8', timeout: 10_000 }).stdout);
record('accessibility permission', check.trusted ? 'pass' : 'blocked', check.trusted ? 'this process is trusted' : 'not granted to the app that started this script (System Settings > Privacy & Security > Accessibility)');
if (!check.trusted) finish(2);
record('session', check.screenLocked || !check.onConsole ? 'blocked' : 'pass', check.screenLocked ? 'the screen is locked; unlock the Mac and rerun' : check.onConsole ? 'unlocked console session' : 'another user session is active');
if (check.screenLocked || !check.onConsole) finish(2);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createCommanderServer } = await import(pathToFileURL(path.join(dist, 'server.js')).href);

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-gui-smoke-')));
const configDir = path.join(work, 'config');
const docName = `astra-gui-smoke-${Date.now()}.txt`;
const docPath = path.join(work, docName);
const ORIGINAL = 'Astra Bridge GUI smoke test: original text.';
const CHANGED = `Astra Bridge GUI smoke test: changed semantically at ${new Date().toISOString()}.`;
fs.writeFileSync(docPath, ORIGINAL);

const commander = createCommanderServer({ configDir });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await commander.server.connect(serverT);
const client = new Client({ name: 'gui-smoke', version: '1' });
await client.connect(clientT);
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { ok: !r.isError, text: text(r) };
}

let code = 0;
let textEditWasRunning = true;
let windowId = null;
try {
  const apps = JSON.parse(spawnSync(helper, ['apps'], { input: '{}', encoding: 'utf8' }).stdout).apps;
  textEditWasRunning = apps.some((a) => a.bundleId === 'com.apple.TextEdit');

  const opened = spawnSync('open', ['-g', '-a', 'TextEdit', docPath], { encoding: 'utf8' });
  record('open throwaway document in TextEdit', opened.status === 0 ? 'pass' : 'fail', opened.status === 0 ? docPath : opened.stderr.trim());
  if (opened.status !== 0) throw new Error('open failed');

  // 1. Discover the window semantically (by its title), no coordinates.
  let listing = '';
  for (let i = 0; i < 40 && windowId === null; i++) {
    const r = await call('list_windows', { app: 'com.apple.TextEdit' });
    listing = r.text;
    const m = new RegExp(`window "${docName.replace(/\./g, '\\.')}" windowId=(\\d+)`).exec(r.text);
    if (m) windowId = Number(m[1]);
    else await sleep(250);
  }
  record('list_windows finds the document window', windowId ? 'pass' : 'fail', windowId ? `windowId=${windowId}` : listing.slice(0, 400));
  if (!windowId) throw new Error('window not found');

  // 2. Find the text area by role.
  const insp = await call('inspect_ui', { app: 'com.apple.TextEdit', windowId, role: 'AXTextArea' });
  const refs = [...insp.text.matchAll(/ref=(ax1:\S+)/g)].map((m) => m[1]);
  record('inspect_ui finds exactly one text area by role', insp.ok && refs.length === 1 ? 'pass' : 'fail', refs[0] ?? insp.text.slice(0, 400));
  if (refs.length !== 1) throw new Error('text area not unique');
  const areaRef = refs[0];
  const hasOriginal = insp.text.includes(JSON.stringify(ORIGINAL));
  record('inspect_ui shows the current text', hasOriginal ? 'pass' : 'fail');

  // 3. Change it, confirm, restore.
  const set1 = await call('set_element_value', { ref: areaRef, value: CHANGED });
  const v1 = set1.ok && /Verified:/.test(set1.text);
  record('set_element_value changes the text (read-back verified)', v1 ? 'pass' : 'fail', set1.text.split('\n')[0]);
  const again = await call('inspect_ui', { ref: areaRef });
  record('inspect_ui sees the new text', again.text.includes(JSON.stringify(CHANGED).slice(0, 150)) ? 'pass' : 'fail');
  const set2 = await call('set_element_value', { ref: areaRef, value: ORIGINAL });
  const v2 = set2.ok && /Verified:/.test(set2.text);
  record('set_element_value restores the original text (verified)', v2 ? 'pass' : 'fail', set2.text.split('\n')[0]);

  // Ambiguity guard, live: every window has several buttons, so role alone must not act.
  const amb = await call('press_element', { app: 'com.apple.TextEdit', windowId, role: 'AXButton' });
  record('press_element refuses an ambiguous selector (nothing pressed)', !amb.ok && /ambiguous_element/.test(amb.text) ? 'pass' : 'fail', amb.text.split('\n')[0]);

  // 4. Close the window with its close button (AXPress on subrole AXCloseButton).
  const press = await call('press_element', { app: 'com.apple.TextEdit', windowId, role: 'AXCloseButton' });
  const closed = press.ok && /the window closed/.test(press.text);
  record('press_element closes the window via its close button', closed ? 'pass' : 'fail', press.text.split('\n').slice(0, 3).join(' | '));
  if (!closed) {
    const after = await call('list_windows', { app: 'com.apple.TextEdit' });
    record('window state after press', 'info', after.text.slice(0, 600));
  } else {
    windowId = null;
  }
  if (steps.some((s) => s.status === 'fail')) code = 1;
} catch (err) {
  record('smoke run', 'fail', err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  await client.close().catch(() => {});
  await commander.shutdown();
  const onDisk = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : null;
  record('throwaway file content at the end', onDisk === null || onDisk === ORIGINAL ? 'pass' : 'info', onDisk === null ? 'not on disk' : JSON.stringify(onDisk.slice(0, 120)));
  if (!textEditWasRunning && windowId === null) {
    const apps = JSON.parse(spawnSync(helper, ['apps'], { input: '{}', encoding: 'utf8' }).stdout).apps;
    const te = apps.find((a) => a.bundleId === 'com.apple.TextEdit');
    if (te) {
      process.kill(te.pid, 'SIGTERM');
      record('quit TextEdit (this script launched it)', 'pass', `pid ${te.pid}`);
    }
  } else if (windowId !== null) {
    record('cleanup', 'info', `the smoke window (windowId ${windowId}) was left open; close it by hand (its file is throwaway)`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  record('temp directory removed', fs.existsSync(work) ? 'fail' : 'pass', work);
}
finish(code || (steps.some((s) => s.status === 'fail') ? 1 : 0));
