import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_POLICY } from './policy.js';

export class DomainPolicy extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        revision INTEGER PRIMARY KEY,
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        changes TEXT NOT NULL
      )
    `);
    const [row] = this.sql.exec('SELECT value FROM policy WHERE id = 1').toArray();
    // Fill in fields added after a policy was first saved, such as `managed`.
    this.policy = { ...DEFAULT_POLICY, ...(row ? JSON.parse(row.value) : {}) };
  }

  getPolicy() {
    return this.policy;
  }

  getAudit() {
    return this.sql.exec('SELECT revision, changed_at, actor, changes FROM audit ORDER BY revision DESC LIMIT 50')
      .toArray()
      .map((row) => ({
        revision: row.revision,
        changedAt: row.changed_at,
        actor: row.actor,
        changes: JSON.parse(row.changes),
      }));
  }

  update(patch, actor, expectedRevision) {
    const changes = Object.entries(patch)
      .filter(([field, value]) => !Object.is(this.policy[field], value))
      .map(([field, after]) => ({ field, before: this.policy[field], after }));

    if (!changes.length) return { policy: this.policy };
    if (expectedRevision !== null && expectedRevision !== this.policy.revision) {
      return { conflict: true, policy: this.policy };
    }
    return { policy: this.#save({ ...this.policy, ...patch }, actor, changes) };
  }

  // Stores a salted digest only. The audit records the username, never the secret.
  setLogin(login, actor) {
    const before = this.policy.login?.username ?? null;
    const changes = [{ field: 'previewLogin', before, after: login.username }];
    return { policy: this.#save({ ...this.policy, login }, actor, changes) };
  }

  // Records each added or removed entry. A changed label shows as a removal and an addition.
  setAllowlist(entries, actor, expectedRevision) {
    const key = (entry) => `${entry.cidr} ${entry.label}`;
    const describe = (entry) => (entry.label ? `${entry.cidr} (${entry.label})` : entry.cidr);
    const before = new Map((this.policy.allowlist ?? []).map((entry) => [key(entry), entry]));
    const after = new Map(entries.map((entry) => [key(entry), entry]));
    const changes = [
      ...[...before].filter(([item]) => !after.has(item)).map(([, entry]) => ({ field: 'allowedIp', before: describe(entry), after: null })),
      ...[...after].filter(([item]) => !before.has(item)).map(([, entry]) => ({ field: 'allowedIp', before: null, after: describe(entry) })),
    ];
    if (!changes.length) return { policy: this.policy };
    if (expectedRevision !== null && expectedRevision !== this.policy.revision) {
      return { conflict: true, policy: this.policy };
    }
    return { policy: this.#save({ ...this.policy, allowlist: entries }, actor, changes) };
  }

  #save(value, actor, changes) {
    const next = { ...value, revision: this.policy.revision + 1 };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT OR REPLACE INTO policy (id, value) VALUES (1, ?)', JSON.stringify(next));
      this.sql.exec(
        'INSERT INTO audit (revision, changed_at, actor, changes) VALUES (?, ?, ?, ?)',
        next.revision, new Date().toISOString(), actor, JSON.stringify(changes),
      );
    });
    this.policy = next;
    return next;
  }
}
