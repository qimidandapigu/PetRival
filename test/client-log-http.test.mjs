import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';

test('client play logs land in data/client-log.jsonl, bounded and per-owner', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'petrival-clientlog-'));
  const app = createApp({ dataDir, env: { AI_MODE: 'algorithm' } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, input) => fetch(base + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });

  const huge = { page: 'jump', entries: Array.from({ length: 40 }, (_, i) => ({ at: 123, kind: 'choice', text: `第 ${i} 条 ${'x'.repeat(600)}` })) };
  const res = await post('/api/log/client', huge);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stored, 30, 'a single batch is capped at 30 entries');

  await post('/api/log/client', { page: 'jump', entries: [{ kind: '', text: '没有类型' }, { kind: 'predict' }, { at: 456, kind: 'predict', text: '预测落空' }] });
  const lines = readFileSync(join(dataDir, 'client-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 31, 'invalid entries are dropped');
  assert.ok(lines.every(l => l.kind.length <= 20 && l.text.length <= 500), 'fields are truncated');
  assert.equal(lines.at(-1).kind, 'predict');
  assert.equal(lines.at(-1).at, 456);
  assert.equal(lines.at(-1).page, 'jump');
  assert.ok(lines[0].owner, 'entries carry the owner id');

  const anon = await fetch(`${base}/api/log/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401, 'a guest identity is still required');
});
