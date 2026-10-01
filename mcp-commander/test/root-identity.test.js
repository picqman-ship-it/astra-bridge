import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, runTool, textOf } from './helpers.js';
import { makeRemoteDir } from './remote-helpers.js';

const { loadRemoteConfig, RemoteConfigSource } = await load('remote/config.js');
const { filesystemTools } = await load('tools/filesystem.js');
const { selectRemoteTools } = await load('remote/policy.js');
const { IdempotencyStore } = await load('remote/idempotency.js');
const { RootGuard } = await load('remote/root-guard.js');
const { validatePath, isWithin } = await load('security/paths.js');
const { validatePathNoFollow } = await load('files/guard.js');

function tools(cfg, roots = new RootGuard(cfg.roots)) {
  return selectRemoteTools(cfg, { roots, jobs: null, idempotency: new IdempotencyStore(cfg) })(
    filesystemTools({ config: new RemoteConfigSource(cfg) }));
}

test('file-only attack: moving a configured root away then replacing it with an outside symlink is refused', async (t) => {
  const r = makeRemoteDir(); t.after(r.cleanup);
  const second = path.join(r.base, 'second'); fs.mkdirSync(second);
  const secret = path.join(r.base, 'outside'); fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'secret'), 'private');
  r.writeConfig({ schemaVersion: 1, roots: [r.work, second] });
  const defs = tools(loadRemoteConfig(r.dir));
  const attackLink = path.join(second, 'outside-link'); fs.symlinkSync(secret, attackLink);
  for (const [source, destination] of [[r.work, path.join(second, 'moved')], [attackLink, r.work]]) {
    const result = await runTool(defs, 'move_file', { source, destination });
    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /configured root/);
  }
  assert.ok(fs.lstatSync(r.work).isDirectory());
  const read = await runTool(defs, 'read_file', { path: path.join(attackLink, 'secret') });
  assert.equal(read.isError, true);
  assert.equal(fs.readFileSync(path.join(secret, 'secret'), 'utf8'), 'private');
});

test('nested roots and their ancestors cannot be moved/replaced, including case aliases on insensitive volumes', async (t) => {
  const r = makeRemoteDir(); t.after(r.cleanup);
  const parent = path.join(r.work, 'parent'); const nested = path.join(parent, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  r.writeConfig({ schemaVersion: 1, roots: [r.work, nested] });
  const defs = tools(loadRemoteConfig(r.dir));
  const candidates = [parent, nested];
  if (fs.existsSync(path.join(r.work, 'PARENT'))) candidates.push(path.join(r.work, 'PARENT'));
  for (const source of candidates) {
    const result = await runTool(defs, 'move_file', { source, destination: path.join(r.work, 'renamed') });
    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /configured root/);
  }
  fs.writeFileSync(path.join(r.work, 'a'), 'ok');
  assert.ok(!(await runTool(defs, 'move_file', { source: path.join(r.work, 'a'), destination: path.join(r.work, 'b') })).isError);
});

for (const replacement of ['symlink', 'directory', 'ancestor-symlink']) {
  test(`runtime root identity stays pinned after external ${replacement} replacement, across sessions`, async (t) => {
    const r = makeRemoteDir(); t.after(r.cleanup);
    const cfg = loadRemoteConfig(r.dir); const guard = new RootGuard(cfg.roots);
    const defs = tools(cfg, guard);
    if (replacement === 'ancestor-symlink') {
      // Use a nested root, so its parent can be replaced without moving the private job store.
      const nested = path.join(r.work, 'nested'); fs.mkdirSync(nested);
      const nestedGuard = new RootGuard([nested]);
      const moved = path.join(r.base, 'moved'); fs.renameSync(r.work, moved); fs.symlinkSync(moved, r.work);
      assert.throws(() => nestedGuard.assertStable(), /identity changed/);
      return;
    }
    fs.renameSync(r.work, path.join(r.base, 'old-root'));
    if (replacement === 'directory') fs.mkdirSync(r.work);
    else fs.symlinkSync(r.dir, r.work);
    for (const session of [defs, tools(cfg, guard)]) {
      for (const [name, args] of [
        ['read_file', { path: path.join(r.work, 'remote.json') }],
        ['write_file', { path: path.join(r.work, 'escape'), content: 'bad' }],
        ['get_file_info', { path: r.work }],
      ]) {
        const result = await runTool(session, name, args);
        assert.equal(result.isError, true, textOf(result));
        assert.match(textOf(result), /identity changed/);
      }
    }
    assert.equal(fs.existsSync(path.join(r.dir, 'escape')), false);
  });
}

test('work and WORK containment follows actual filesystem identity, including nonexistent write targets', async (t) => {
  const r = makeRemoteDir(); t.after(r.cleanup);
  const upper = path.join(r.base, 'WORK');
  assert.equal(isWithin('/WORK/secret', '/work'), false);
  if (fs.existsSync(upper)) {
    fs.writeFileSync(path.join(r.work, 'ok'), 'ok');
    assert.equal(await validatePath(path.join(upper, 'ok'), [r.work]), path.join(r.work, 'ok'));
    assert.equal(await validatePathNoFollow(upper, [r.work]), upper);
    assert.equal(await validatePath(path.join(upper, 'new'), [r.work]), path.join(r.work, 'new'));
  } else {
    fs.mkdirSync(upper); fs.writeFileSync(path.join(upper, 'secret'), 'private');
    for (const target of [upper, path.join(upper, 'secret'), path.join(upper, 'new')]) {
      await assert.rejects(validatePath(target, [r.work]), /Path not allowed/);
      await assert.rejects(validatePathNoFollow(target, [r.work]), /Path not allowed/);
    }
    fs.symlinkSync(upper, path.join(r.work, 'link'));
    await assert.rejects(validatePath(path.join(r.work, 'link/secret'), [r.work]), /Path not allowed/);
  }
});
