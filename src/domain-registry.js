import { DurableObject } from 'cloudflare:workers';

// The list of managed domains. It starts from the DOMAINS variable once, then the
// dashboard adds and removes entries. Each domain's settings live in DomainPolicy.
export class DomainRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS domains (hostname TEXT PRIMARY KEY, position INTEGER NOT NULL, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  #all() {
    return this.sql.exec('SELECT value FROM domains ORDER BY position').toArray().map((row) => JSON.parse(row.value));
  }

  list(seed = []) {
    const [seeded] = this.sql.exec("SELECT value FROM meta WHERE key = 'seeded'").toArray();
    if (!seeded) {
      this.ctx.storage.transactionSync(() => {
        seed.forEach((entry, index) => {
          this.sql.exec('INSERT OR IGNORE INTO domains (hostname, position, value) VALUES (?, ?, ?)', entry.hostname, index, JSON.stringify(entry));
        });
        this.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
      });
    }
    return this.#all();
  }

  add(entry, reserved = []) {
    const taken = new Set([
      ...reserved,
      ...this.#all().flatMap((item) => [item.hostname, item.preview, ...(item.aliases ?? [])]),
    ].filter(Boolean));
    const clash = [entry.hostname, entry.preview, ...(entry.aliases ?? [])].find((host) => host && taken.has(host));
    if (clash) return { conflict: clash };
    const [{ next }] = this.sql.exec('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM domains').toArray();
    this.sql.exec('INSERT INTO domains (hostname, position, value) VALUES (?, ?, ?)', entry.hostname, next, JSON.stringify(entry));
    return { domains: this.#all() };
  }

  remove(hostname) {
    this.sql.exec('DELETE FROM domains WHERE hostname = ?', hostname);
    return { domains: this.#all() };
  }
}
