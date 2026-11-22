// A small stand-in for Cloudflare D1 on top of Node's built-in SQLite, so database code can be tested
// without starting a worker. It covers what the app uses: prepare/bind, first/all/run and batch.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, unknown>;

class Statement {
  constructor(
    private db: InstanceType<typeof DatabaseSync>,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }

  private values() {
    return this.params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as never[];
  }

  async first<T = Row>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...this.values()) as T | undefined) ?? null) as T | null;
  }

  async all<T = Row>() {
    return this.exec<T>();
  }

  async run<T = Row>() {
    return this.exec<T>();
  }

  exec<T = Row>() {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(select|with|explain)/i.test(this.sql)) {
      return { results: stmt.all(...this.values()) as T[], success: true, meta: { changes: 0 } };
    }
    const info = stmt.run(...this.values());
    return { results: [] as T[], success: true, meta: { changes: Number(info.changes) } };
  }
}

export function memoryD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql: string) => db.exec(sql),
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}

/** A fresh in-memory database with every migration applied. */
export function migratedD1() {
  const m = memoryD1();
  const dir = join(import.meta.dirname, '..', 'migrations');
  for (const f of readdirSync(dir).sort()) m.raw.exec(readFileSync(join(dir, f), 'utf8'));
  return m;
}
