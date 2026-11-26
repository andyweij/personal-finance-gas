/**
 * H5 (v1.8.13): counts D1 queries the way Cloudflare's per-invocation limit does (each first / all / run / raw on
 * a prepared statement, and each batch() call, is one query) so a request can stop before exceeding the limit.
 *
 * Statements are never wrapped or patched (real db.batch() needs genuine D1PreparedStatement objects). Instead:
 * used = statements prepared + batch() calls − statements sent inside a batch. A statement that is prepared but
 * never executed is still counted, so the estimate can only be too high (the safe direction).
 */
export interface D1QueryCounter {
  db: D1Database;
  used(): number;
}

export function countD1Queries(db: D1Database): D1QueryCounter {
  let prepared = 0;
  let batchCalls = 0;
  let batchedStatements = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepared += 1;
          return target.prepare(query);
        };
      }
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          batchCalls += 1;
          batchedStatements += Array.isArray(stmts) ? stmts.length : 0;
          return target.batch(stmts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, used: () => Math.max(0, prepared + batchCalls - batchedStatements) };
}
