import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';

test('real HTTP skill routes authenticate, count, validate, save and serve editor assets', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'petrival-skill-http-'));
  const app = createApp({ dataDir: dir, env: { AI_MODE: 'algorithm' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(data) });
  assert.equal((await post('/api/pets/skill/check', {})).status, 401);
  const session = await post('/api/session', {}); cookie = session.headers.get('set-cookie').split(';')[0];
  await post('/api/pets', { name: '接口测试', species: 'xiaotangyuan' });
  const skill = { name: '观察', gameId: 'sokoban', description: '暂时沿用原有决策。', code: '(ctx: SkillContext) => null' };
  const checked = await (await post('/api/pets/skill/check', skill)).json();
  assert.equal(checked.valid, true); assert.ok(checked.tokens > 0);
  assert.equal(Object.hasOwn(checked, 'program'), false);
  assert.equal((await post('/api/pets/skill', { revision: 0, skill })).status, 200);
  assert.equal((await post('/api/pets/skill', { revision: 0, skill: null })).status, 409);
  assert.equal((await post('/api/pets/skill', { revision: 1, skill: { ...skill, description: ' a'.repeat(110) } })).status, 422);
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
  assert.equal(state.mine.competition.equipped.code, skill.code);
  for (const path of ['/skill-editor.mjs', '/skill-editor.css']) assert.equal((await fetch(base + path)).status, 200);
});
