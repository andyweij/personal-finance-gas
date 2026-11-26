import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const currentDir = dirname(fileURLToPath(import.meta.url));

type SqlParam = string | number | null | Uint8Array;

function normalizeParam(val: unknown): SqlParam {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'number' || typeof val === 'string' || val instanceof Uint8Array) {
    return val;
  }
  return String(val);
}

class MockD1PreparedStatement {
  private boundParams: SqlParam[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.boundParams = values.map(normalizeParam);
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.query);
    const row = stmt.get(...this.boundParams) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return { ...row } as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.boundParams) as Record<string, unknown>[];
    return {
      results: rows.map((r) => ({ ...r })) as T[],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const stmt = this.db.prepare(this.query);
    if (/^\s*(SELECT|WITH)\b/i.test(this.query) || /\bRETURNING\b/i.test(this.query)) {
      // Like real D1, a batched read returns its rows
      const rows = stmt.all(...this.boundParams) as Record<string, unknown>[];
      return {
        results: rows.map((r) => ({ ...r })) as T[],
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }
    const res = stmt.run(...this.boundParams);
    return {
      results: [] as T[],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(res.changes ?? 0),
        last_row_id: Number(res.lastInsertRowid ?? 0),
        changed_db: Number(res.changes ?? 0) > 0,
        changes: Number(res.changes ?? 0),
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.boundParams) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

/**
 * @param opts.stopBefore apply only migrations whose file name sorts before this prefix (e.g. '0017') — used to
 *   build a database with an older schema, fill it, and then apply a newer migration with `db.exec`.
 */
export function createTestD1(opts: { stopBefore?: string } = {}): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  const migrationsDir = resolve(currentDir, '../../migrations');
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !opts.stopBefore || f < opts.stopBefore)
    .sort();
  for (const file of sqlFiles) {
    const migrationSql = readFileSync(resolve(migrationsDir, file), 'utf8');
    sqlite.exec(migrationSql);
  }

  const mockDb = {
    prepare(query: string) {
      return new MockD1PreparedStatement(sqlite, query);
    },
    async batch<T = unknown>(statements: MockD1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      sqlite.exec('BEGIN');
      try {
        for (const stmt of statements) {
          results.push(stmt.runSync<T>());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
  };

  return mockDb as unknown as D1Database;
}

/**
 * H5 (v1.8.12+): wraps a D1 database and counts calls the way Cloudflare counts D1 queries per invocation —
 * every `first` / `all` / `run` / `raw` on a prepared statement, and every `batch()` call, is one query.
 */
export function createCountingD1(inner: D1Database = createTestD1()): { db: D1Database; count: () => number; reset: () => void } {
  let calls = 0;
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'bind') {
          return (...args: unknown[]) => wrapStmt((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return (...args: unknown[]) => {
            calls += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (q: string) => wrapStmt(target.prepare(q));
      }
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          calls += 1;
          return target.batch(stmts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, count: () => calls, reset: () => (calls = 0) };
}
