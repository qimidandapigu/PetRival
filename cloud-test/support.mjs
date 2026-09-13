import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export function database() {
  const connection = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) connection.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  const wrap = (sql, params = []) => ({ sql, params, bind(...next) { return wrap(sql, next); },
    async run() { const info = connection.prepare(sql).run(...params); return { success: true, meta: { changes: Number(info.changes) } }; },
    async all() { return { results: connection.prepare(sql).all(...params), success: true, meta: { changes: 0 } }; },
  });
  return { connection, prepare: wrap,
    async batch(statements) {
      connection.exec('BEGIN');
      try { const result = statements.map(s => {
        const statement = connection.prepare(s.sql);
        if (/^SELECT\b/i.test(s.sql)) return { results: statement.all(...s.params), meta: { changes: 0 }, success: true };
        const info = statement.run(...s.params); return { results: [], meta: { changes: Number(info.changes) }, success: true };
      }); connection.exec('COMMIT'); return result; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
  };
}
