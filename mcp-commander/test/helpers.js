// Shared test helpers. Tests import compiled code from dist/ (or from $MCPC_DIST, which lets
// several builds coexist, e.g. `MCPC_DIST=build/x node --test test/foo.test.js`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DIST = path.resolve(ROOT, process.env.MCPC_DIST ?? 'dist');

/** Dynamic import of a compiled module, e.g. load('tools/filesystem.js'). */
export function load(rel) {
  return import(pathToFileURL(path.join(DIST, rel)).href);
}

/** Creates a fresh temp dir (realpath'd, so /var vs /private/var never matters). */
export function tmpDir(prefix = 'mcpc-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** A ToolContext backed by a throwaway config dir; `overrides` are written into config.json. */
export async function makeCtx(overrides = {}) {
  const { ConfigManager } = await load('config.js');
  const configDir = tmpDir('mcpc-config-');
  const config = new ConfigManager(configDir);
  for (const [k, v] of Object.entries(overrides)) config.set(k, v);
  return {
    ctx: { config, getClientInfo: () => ({ name: 'test', version: '0' }) },
    configDir,
    cleanup: () => rmrf(configDir),
  };
}

/** Calls a ToolDef handler directly and normalizes the result the way server.ts does. */
export async function runTool(defs, name, args = {}) {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`No tool ${name} in [${defs.map((d) => d.name).join(', ')}]`);
  try {
    const out = await def.handler(args);
    return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: msg.startsWith('Error') ? msg : `Error: ${msg}` }], isError: true };
  }
}

export function textOf(result) {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/**
 * A real MCP client connected in-process to a real server (InMemoryTransport), so tests go
 * through the SDK's schema validation and server.ts's wrapper exactly like a client would.
 */
export async function connectInMemory(configOverrides = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createCommanderServer } = await load('server.js');
  const configDir = tmpDir('mcpc-config-');
  const commander = createCommanderServer({ configDir });
  for (const [k, v] of Object.entries(configOverrides)) commander.config.set(k, v);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await commander.server.connect(serverT);
  const client = new Client({ name: 'mcpc-test-client', version: '1.0.0' });
  await client.connect(clientT);
  return {
    client,
    commander,
    call: async (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await commander.shutdown();
      rmrf(configDir);
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls fn() until it returns truthy or the timeout expires. */
export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(interval);
  }
}
