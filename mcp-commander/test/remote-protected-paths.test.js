// Protected locations for remote roots: ~/.astra-bridge (Astra Bridge private keys), extra
// locations from MCP_COMMANDER_PROTECTED_PATHS, and spellings that must not get around the check
// (case and Unicode variants on APFS, macOS firmlinks, symlinks). HOME points at a temp dir in
// every test: the real home, ~/.astra-bridge and ~/.mcp-commander-remote are never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { load } from './helpers.js';
import { makeRemoteDir } from './remote-helpers.js';

const { loadRemoteConfig, PROTECTED_PATHS_ENV } = await load('remote/config.js');
const { RemoteSetupError } = await load('remote/secrets.js');

const ENV_KEYS = ['HOME', 'USERPROFILE', PROTECTED_PATHS_ENV];
const darwin = process.platform === 'darwin';

/** A temp remote dir plus a temp HOME (<base>/home) next to its work dir; env restored afterwards. */
function withHome(fn) {
  const r = makeRemoteDir({ port: 8765 });
  const home = path.join(r.base, 'home');
  fs.mkdirSync(home);
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env[PROTECTED_PATHS_ENV];
    return fn(r, home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    r.cleanup();
  }
}

function load_(r, roots) {
  r.writeConfig({ schemaVersion: 1, roots });
  return loadRemoteConfig(r.dir);
}

function refused(r, roots, pattern) {
  assert.throws(
    () => load_(r, roots),
    (err) => err instanceof RemoteSetupError && pattern.test(err.message),
    `expected roots ${JSON.stringify(roots)} to be refused with ${pattern}`,
  );
}

function accepted(r, roots) {
  return load_(r, roots).roots;
}

const OVERLAP_ASTRA = /overlaps protected location .*\.astra-bridge/;

/** True when the filesystem resolves `variant` to the same directory as `canonical`. */
function aliases(variant, canonical) {
  try {
    const a = fs.statSync(variant, { bigint: true });
    const b = fs.statSync(canonical, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

describe('~/.astra-bridge is a protected location', () => {
  it('refuses a root that is or is inside ~/.astra-bridge; accepts an unrelated root', () => {
    withHome((r, home) => {
      const keys = path.join(home, '.astra-bridge');
      fs.mkdirSync(path.join(keys, 'keys'), { recursive: true });
      refused(r, [keys], OVERLAP_ASTRA);
      refused(r, [path.join(keys, 'keys')], OVERLAP_ASTRA);
      refused(r, [r.work, keys], OVERLAP_ASTRA); // one bad root is enough
      // Containing it means containing the home directory, which has its own refusal.
      refused(r, [home], /home directory or contains it/);
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
    });
  });

  it('follows ~/.astra-bridge when it is a symlink, even a dangling one, and refuses a root around the target', () => {
    withHome((r, home) => {
      const vault = path.join(r.base, 'vault');
      fs.mkdirSync(path.join(vault, 'astra'), { recursive: true });
      fs.symlinkSync(path.join(vault, 'astra'), path.join(home, '.astra-bridge'));
      // The message names the resolved location, i.e. the link's target.
      refused(r, [vault], /overlaps protected location .*vault.astra/);
      refused(r, [path.join(vault, 'astra')], /overlaps protected location .*vault.astra/);
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
    });
    withHome((r, home) => {
      const later = path.join(r.base, 'later');
      fs.mkdirSync(later);
      fs.symlinkSync(path.join(later, 'astra'), path.join(home, '.astra-bridge')); // target not created yet
      refused(r, [later], /overlaps protected location .*later.astra/);
    });
  });

  it('protects ~/.astra-bridge before it exists (a root in its place is refused once created)', () => {
    withHome((r, home) => {
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
      fs.mkdirSync(path.join(home, '.astra-bridge'));
      refused(r, [path.join(home, '.astra-bridge')], OVERLAP_ASTRA);
    });
  });
});

describe('MCP_COMMANDER_PROTECTED_PATHS', () => {
  it('protects each listed location: a root may not equal, be inside or contain one', () => {
    withHome((r) => {
      const app = path.join(r.base, 'agent', 'app');
      const other = path.join(r.base, 'other-secret');
      const future = path.join(r.base, 'future', 'code'); // does not exist yet
      fs.mkdirSync(path.join(app, 'src'), { recursive: true });
      fs.mkdirSync(other);
      fs.mkdirSync(path.join(r.base, 'future'));
      process.env[PROTECTED_PATHS_ENV] = [app, other, future].join(path.delimiter);
      refused(r, [app], /overlaps protected location .*agent.app/);
      refused(r, [path.join(app, 'src')], /overlaps protected location .*agent.app/);
      refused(r, [path.join(r.base, 'agent')], /overlaps protected location .*agent.app/);
      refused(r, [other], /overlaps protected location .*other-secret/);
      refused(r, [path.join(r.base, 'future')], /overlaps protected location .*future.code/);
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
      // The built-in list still applies alongside the extra entries.
      refused(r, [r.dir], /overlaps protected location/);
    });
  });

  it('realpaths entries, so a symlinked entry protects its target', () => {
    withHome((r) => {
      const real = path.join(r.base, 'real-code');
      fs.mkdirSync(real);
      const link = path.join(r.base, 'link-to-code');
      fs.symlinkSync(real, link);
      process.env[PROTECTED_PATHS_ENV] = link;
      refused(r, [real], /overlaps protected location .*real-code/);
    });
  });

  it('ignores empty entries (unset, "", "::", trailing ":" or blanks)', () => {
    withHome((r) => {
      const d = path.delimiter;
      for (const value of ['', d, `${d}${d}`, `  ${d} ${d}`, `${d}${path.join(r.base, 'agent')}${d}${d}`]) {
        process.env[PROTECTED_PATHS_ENV] = value;
        assert.deepEqual(accepted(r, [r.work]), [r.work], JSON.stringify(value));
      }
    });
  });

  it('stops the server on a relative entry, naming the variable', () => {
    withHome((r) => {
      for (const bad of ['relative/dir', '~/code', './x', ' /leading-space']) {
        process.env[PROTECTED_PATHS_ENV] = [path.join(r.base, 'ok'), bad].join(path.delimiter);
        assert.throws(
          () => load_(r, [r.work]),
          (err) => err instanceof RemoteSetupError && err.message.includes(PROTECTED_PATHS_ENV) && /must be an absolute path/.test(err.message),
          bad,
        );
      }
    });
  });
});

describe('protected locations cannot be bypassed by another spelling', () => {
  it('stores and compares roots in their on-disk spelling (case, Unicode, symlinks)', { skip: !darwin && 'APFS case/normalization behaviour is macOS-only' }, (t) => {
    withHome((r, home) => {
      const keys = path.join(home, '.astra-bridge');
      fs.mkdirSync(path.join(keys, 'keys'), { recursive: true });
      if (!aliases(path.join(home, '.ASTRA-BRIDGE'), keys)) {
        t.skip('the temp volume is case-sensitive');
        return;
      }
      const variants = [
        path.join(home, '.Astra-Bridge'),
        path.join(home, '.ASTRA-BRIDGE', 'Keys'),
        path.join(r.base, 'HOME', '.astra-bridge'), // a parent spelled differently
        path.join(home, '.aſtra-bridge'), // U+017F long s: APFS folds it to "s", toLowerCase() does not
      ];
      for (const v of variants) {
        assert.ok(aliases(v, v.endsWith('Keys') ? path.join(keys, 'keys') : keys), `${v} should alias ~/.astra-bridge on this volume`);
        refused(r, [v], OVERLAP_ASTRA);
      }
      // The same for every built-in location, not just the new one.
      fs.mkdirSync(path.join(home, '.ssh'));
      refused(r, [path.join(home, '.ſsh')], /overlaps protected location .*\.ssh/);
      refused(r, [path.join(home, '.SSH')], /overlaps protected location .*\.ssh/);
      // An accepted root is stored as the filesystem spells it.
      assert.deepEqual(accepted(r, [path.join(r.base, 'WORK')]), [r.work]);
    });
  });

  it('matches MCP_COMMANDER_PROTECTED_PATHS entries case- and normalization-insensitively on APFS', { skip: !darwin && 'macOS-only' }, (t) => {
    withHome((r) => {
      const code = path.join(r.base, 'agent-code');
      const cafe = path.join(r.base, 'café'); // NFC on disk
      fs.mkdirSync(path.join(code, 'src'), { recursive: true });
      fs.mkdirSync(path.join(cafe, 'src'), { recursive: true });
      if (!aliases(path.join(r.base, 'AGENT-CODE'), code)) {
        t.skip('the temp volume is case-sensitive');
        return;
      }
      process.env[PROTECTED_PATHS_ENV] = [path.join(r.base, 'Agent-Code'), path.join(r.base, 'café')].join(path.delimiter);
      refused(r, [path.join(code, 'src')], /overlaps protected location .*agent-code/i);
      refused(r, [path.join(r.base, 'AGENT-CODE')], /overlaps protected location .*agent-code/i);
      refused(r, [path.join(cafe, 'src')], /overlaps protected location/);
      if (aliases(path.join(r.base, 'café'), cafe)) refused(r, [path.join(r.base, 'CAFÉ', 'src')], /overlaps protected location/);
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
    });
  });

  it('sees through macOS firmlinks (/System/Volumes/Data/...) and refuses the Data volume itself', { skip: !darwin && 'macOS-only' }, (t) => {
    const DATA = '/System/Volumes/Data';
    withHome((r, home) => {
      const keys = path.join(home, '.astra-bridge');
      fs.mkdirSync(keys);
      const twin = (p) => path.join(DATA, p);
      if (!aliases(twin(keys), keys)) {
        t.skip(`${r.base} has no firmlink twin under ${DATA}`);
        return;
      }
      refused(r, [twin(keys)], OVERLAP_ASTRA);
      refused(r, [twin(r.dir)], /overlaps protected location/);
      refused(r, [twin(home)], /home directory or contains it/);
      refused(r, [DATA], /home directory or contains it/);
      refused(r, ['/System/Volumes'], /home directory or contains it/);
      refused(r, ['/System'], /home directory or contains it/);
      process.env[PROTECTED_PATHS_ENV] = path.join(r.base, 'agent');
      fs.mkdirSync(path.join(r.base, 'agent', 'src'), { recursive: true });
      refused(r, [twin(path.join(r.base, 'agent', 'src'))], /overlaps protected location .*agent/);
      // An unrelated root is still fine under either spelling.
      assert.deepEqual(accepted(r, [r.work]), [r.work]);
      assert.deepEqual(accepted(r, [twin(r.work)]), [twin(r.work)]);
    });
  });
});

describe('protectedPaths in remote.json', () => {
  it('refuses a root that overlaps a location listed in remote.json, for every loader', () => {
    withHome((r) => {
      const outer = path.join(r.base, 'outer');
      const agent = path.join(outer, 'agent-code');
      fs.mkdirSync(path.join(agent, 'src'), { recursive: true });
      const write = (roots) => r.writeConfig({ schemaVersion: 1, roots, protectedPaths: [agent] });
      for (const roots of [[agent], [path.join(agent, 'src')], [outer]]) {
        write(roots);
        assert.throws(() => loadRemoteConfig(r.dir), (err) => err instanceof RemoteSetupError && /overlaps protected location .*agent-code/.test(err.message));
      }
      write([r.work]);
      assert.ok(loadRemoteConfig(r.dir).roots.length === 1, 'an unrelated root is still accepted');
    });
  });

  it('rejects relative and space-padded entries in remote.json', () => {
    withHome((r) => {
      for (const entry of ['relative/dir', `${r.base} `, ` ${r.base}`]) {
        r.writeConfig({ schemaVersion: 1, roots: [r.work], protectedPaths: [entry] });
        assert.throws(() => loadRemoteConfig(r.dir), (err) => err instanceof RemoteSetupError && /protectedPaths entry/.test(err.message));
      }
    });
  });

  it('rejects a space-padded entry in the environment variable', () => {
    withHome((r) => {
      process.env[PROTECTED_PATHS_ENV] = `${path.join(r.base, 'x')} `;
      assert.throws(() => load_(r, [r.work]), (err) => err instanceof RemoteSetupError && /without surrounding spaces/.test(err.message));
    });
  });
});
