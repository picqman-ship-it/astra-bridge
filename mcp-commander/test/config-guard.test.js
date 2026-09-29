import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { load, tmpDir, rmrf, textOf, connectInMemory } from './helpers.js';
const { createCommanderServer } = await load('server.js');
const { getDefaultConfig } = await load('config.js');

async function brokenClient(raw) {
  const dir = tmpDir('mcpc-config-guard-');
  const file = path.join(dir, 'config.json');
  if (raw === 'DIRECTORY') fs.mkdirSync(file);
  else fs.writeFileSync(file, raw);
  const commander = createCommanderServer({ configDir: dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await commander.server.connect(st);
  const client = new Client({ name: 'config-guard-test', version: '1' });
  await client.connect(ct);
  return { dir, file, commander,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => { await client.close(); await commander.shutdown(); rmrf(dir); },
  };
}
for (const [label, raw] of [
  ['corrupt JSON', '{'], ['invalid directories', '{"allowedDirectories":[1]}'],
  ['invalid blocklist', '{"blockedCommands":42}'], ['non-object', '[]'],
  ['unreadable config path', 'DIRECTORY'],
]) test(`MCP fails closed with ${label} at startup and recovers`, async () => {
  const c = await brokenClient(raw);
  try {
    const status = await c.call('get_config');
    assert.ok(!status.isError, textOf(status));
    assert.ok(c.commander.config.loadError, 'diagnostic must expose the config error');
    const target = path.join(c.dir, 'must-not-exist.txt');
    for (const [name, args] of [
      ['read_file', { path: c.file }],
      ['write_file', { path: target, content: 'unsafe' }],
      ['start_process', { command: 'printf must-not-run', timeout_ms: 100 }],
      ['set_config_value', { key: 'allowedDirectories', value: [] }],
    ]) {
      const result = await c.call(name, args);
      assert.equal(result.isError, true, `${name}: ${textOf(result)}`);
      assert.match(textOf(result), /Configuration is unusable/);
    }
    assert.equal(fs.existsSync(target), false);
    if (raw === 'DIRECTORY') fs.rmdirSync(c.file);
    fs.writeFileSync(c.file, JSON.stringify({ ...getDefaultConfig(), allowedDirectories: [c.dir] }));
    const recovered = await c.call('read_file', { path: c.file });
    assert.ok(!recovered.isError, textOf(recovered));
    assert.equal(c.commander.config.loadError, null);
  } finally { await c.close(); }
});

test('invalid security hot reload preserves restrictions and blocks new work', async () => {
  const c = await connectInMemory();
  try {
    const dir = c.commander.config.dir;
    c.commander.config.set('allowedDirectories', [dir]);
    for (const malformed of ['{', '{"allowedDirectories":[1]}', '{"blockedCommands":false}', 'null']) {
      fs.writeFileSync(c.commander.config.file, malformed);
      const denied = await c.call('read_file', { path: c.commander.config.file });
      assert.equal(denied.isError, true, textOf(denied));
      assert.deepEqual(c.commander.config.getValue('allowedDirectories'), [dir]);
      const sessions = await c.call('list_sessions');
      assert.ok(!sessions.isError, 'diagnostics must remain available');
      fs.writeFileSync(c.commander.config.file, JSON.stringify({ ...getDefaultConfig(), allowedDirectories: [dir] }));
      const ok = await c.call('read_file', { path: c.commander.config.file });
      assert.ok(!ok.isError, textOf(ok));
    }
  } finally { await c.close(); }
});

test('unwritable config location blocks new work until the location is repaired', async () => {
  const root = tmpDir('mcpc-config-location-');
  const dir = path.join(root, 'config-dir');
  fs.writeFileSync(dir, 'a file blocks creation of the config directory');
  const commander = createCommanderServer({ configDir: dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await commander.server.connect(st);
  const client = new Client({ name: 'config-location-test', version: '1' });
  await client.connect(ct);
  try {
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    assert.ok(!(await call('get_config')).isError);
    assert.match(commander.config.loadError ?? '', /Could not create/);
    const denied = await call('start_process', { command: 'printf must-not-run', timeout_ms: 100 });
    assert.equal(denied.isError, true, textOf(denied));
    fs.unlinkSync(dir); // Only the blocker created inside this test's private temp dir.
    fs.mkdirSync(dir);
    fs.writeFileSync(commander.config.file, JSON.stringify({ ...getDefaultConfig(), allowedDirectories: [root] }));
    const ok = await call('read_file', { path: commander.config.file });
    assert.ok(!ok.isError, textOf(ok));
    assert.equal(commander.config.loadError, null);
  } finally { await client.close(); await commander.shutdown(); rmrf(root); }
});

test('deleting corrupt config does not silently unlock the server; explicit repair does', async () => {
  const c = await brokenClient('{');
  try {
    fs.unlinkSync(c.file);
    const denied = await c.call('set_config_value', { key: 'allowedDirectories', value: [] });
    assert.equal(denied.isError, true, textOf(denied));
    assert.match(textOf(denied), /Configuration is unusable/);
    assert.ok(!(await c.call('get_config')).isError);
    fs.writeFileSync(c.file, JSON.stringify({ ...getDefaultConfig(), allowedDirectories: [c.dir] }));
    const ok = await c.call('read_file', { path: c.file });
    assert.ok(!ok.isError, textOf(ok));
  } finally { await c.close(); }
});
