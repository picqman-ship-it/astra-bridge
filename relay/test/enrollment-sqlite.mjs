// Real SQLite transaction adapter, not a pattern-matching SQL mock. D1 batch's
// documented commit/rollback contract is modeled explicitly; never connects remotely.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export function sqliteRegistry(file = ":memory:", { migrate = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
  if (migrate) {
    for (const name of ["0001_closed_beta_registry.sql", "0002_beta_enrollment_invites.sql", "0003_beta_agent_key_unique.sql"]) {
      db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }
  const registry = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async run() { return db.prepare(sql).run(...values); },
        execute() { return db.prepare(sql).all(...values); },
      };
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map(s => ({ success: true, results: s.execute() }));
        db.exec("COMMIT");
        return result;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
  };
  return { db, registry };
}
