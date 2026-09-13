import { randomUUID } from 'node:crypto';

// A small arena uses one revision fence. Every changed entity and score entry is
// committed in the same D1 batch; stale requests cannot overwrite newer results.
const collections = {
  sessions: { table: 'sessions', columns: ['id', 'owner', 'data'], values: (id, v) => [id, v.owner, JSON.stringify(v)] },
  pets: { table: 'pets', columns: ['id', 'name', 'owner', 'score', 'rank_ms', 'played', 'bot', 'data'], values: (id, v) => [id, v.name, v.owner, v.score, v.rankMs, v.played, +v.bot, JSON.stringify(v)] },
  levels: { table: 'levels', columns: ['id', 'pet_id', 'method', 'created_at', 'data'], values: (id, v) => [id, v.petId, v.method, v.createdAt, JSON.stringify(v)] },
  challenges: { table: 'matches', columns: ['id', 'status', 'training', 'created_at', 'winner', 'data'], values: (id, v) => [id, v.status, +v.training, v.createdAt, v.winner || null, JSON.stringify(v)] },
  practices: { table: 'practices', columns: ['id', 'owner', 'data'], values: (id, v) => [id, v.owner, JSON.stringify(v)] },
  jobs: { table: 'jobs', columns: ['id', 'kind', 'status', 'data'], values: (id, v) => [id, v.kind, v.status, JSON.stringify(v)] },
};
export class CloudStore {
  static async load(db) {
    await db.prepare("INSERT INTO arena_meta (id, revision, token) VALUES (1, 0, '') ON CONFLICT(id) DO NOTHING").run();
    const queries = ['SELECT revision FROM arena_meta WHERE id = 1', ...Object.values(collections).map(c => `SELECT id, data FROM ${c.table}`)];
    const results = await db.batch(queries.map(q => db.prepare(q)));
    const store = new CloudStore(); store.db = db; store.revision = results[0].results[0].revision;
    store.state = { version: 1 }; store.before = {}; store.ledger = [];
    Object.keys(collections).forEach((key, i) => {
      store.state[key] = {}; store.before[key] = {};
      for (const row of results[i + 1].results) { store.state[key][row.id] = JSON.parse(row.data); store.before[key][row.id] = row.data; }
    });
    return store;
  }
  save() { /* The request boundary commits the complete synchronous operation. */ }
  async commit() {
    const token = randomUUID(), statements = [], gate = 'EXISTS (SELECT 1 FROM arena_meta WHERE id = 1 AND token = ?)';
    for (const [key, c] of Object.entries(collections)) {
      for (const [id, value] of Object.entries(this.state[key])) {
        if (this.before[key][id] === JSON.stringify(value)) continue;
        const values = c.values(id, value);
        statements.push(this.db.prepare(`INSERT INTO ${c.table} (${c.columns.join(',')}) SELECT ${values.map(() => '?').join(',')} WHERE ${gate} ON CONFLICT(id) DO UPDATE SET ${c.columns.slice(1).map(col => `${col}=excluded.${col}`).join(',')}`).bind(...values, token));
      }
      for (const id of Object.keys(this.before[key])) if (!this.state[key][id]) statements.push(this.db.prepare(`DELETE FROM ${c.table} WHERE id = ? AND ${gate}`).bind(id, token));
    }
    for (const v of this.ledger) statements.push(this.db.prepare(`INSERT INTO score_ledger (id, match_id, pet_id, pet_name, delta, total, rank_ms, outcome, created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${gate} ON CONFLICT(match_id,pet_id) DO NOTHING`).bind(v.id, v.matchId, v.petId, v.petName, v.delta, v.total, v.rankMs, v.outcome, v.createdAt, token));
    if (!statements.length) return true;
    const fence = this.db.prepare('UPDATE arena_meta SET revision = revision + 1, token = ? WHERE id = 1 AND revision = ?').bind(token, this.revision);
    const result = await this.db.batch([fence, ...statements]);
    return result[0].meta.changes === 1;
  }
}

export async function transaction(db, action) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const store = await CloudStore.load(db);
    let result, error;
    try { result = action(store); if (result?.then) throw new Error('Network work must run outside a state transaction'); }
    catch (e) { error = e; }
    if (await store.commit()) { if (error) throw error; return result; }
  }
  const error = new Error('擂台正在结算其他比赛，请稍后重试'); error.status = 503; throw error;
}
