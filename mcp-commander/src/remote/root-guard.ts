import fs from 'node:fs';
import { validatePathNoFollow } from '../files/guard.js';
import { isWithin, PathNotAllowedError } from '../security/paths.js';

/** One snapshot per runtime, shared by all its sessions. Never re-authorize a replacement root. */
export class RootGuard {
  private readonly roots;

  constructor(roots: string[]) {
    this.roots = roots.map((root) => {
      const real = fs.realpathSync.native(root);
      const st = fs.statSync(real, { bigint: true });
      if (!st.isDirectory()) throw new PathNotAllowedError(`Configured root is not a directory: ${root}`);
      return { path: root, real, dev: st.dev, ino: st.ino };
    });
  }

  assertStable(): void {
    for (const root of this.roots) {
      try {
        const real = fs.realpathSync.native(root.path);
        const st = fs.statSync(real, { bigint: true });
        if (real === root.real && st.isDirectory() && st.dev === root.dev && st.ino === root.ino) continue;
      } catch { /* Missing/inaccessible roots also revoke access. */ }
      throw new PathNotAllowedError(`Configured root identity changed: ${root.path}. Access refused; the owner must review the roots and restart.`);
    }
  }

  async assertMove(source: string, destination: string): Promise<void> {
    const dirs = this.roots.map((r) => r.real);
    for (const requested of [source, destination]) {
      // A final symlink is moved as a link. Resolve its parent, exactly as move_file does.
      const valid = await validatePathNoFollow(requested, dirs);
      const st = fs.lstatSync(valid, { throwIfNoEntry: false });
      const candidate = st && !st.isSymbolicLink() ? fs.realpathSync.native(valid) : valid;
      if (this.roots.some((r) => isWithin(r.real, candidate))) {
        throw new PathNotAllowedError(`Cannot move or replace a configured root or its ancestor: ${requested}`);
      }
    }
    this.assertStable();
  }
}
