import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Worker runtime tokenizes Chinese and TS, enforces capacity, and reloads skill from D1', { timeout: 60000 }, async t => {
  const output = await build({ entryPoints: ['cloud/worker.mjs'], bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { AI_MODE: 'algorithm' } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) if (sql.trim()) await db.prepare(sql.trim()).run();
  }
  const call = (path, body, owner = 'skill-runtime-owner') => mf.dispatchFetch(`https://runtime.test${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': owner, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/api/pets', { name: '云运行时', species: 'xiaotangyuan', defense: true })).status, 201);
  const skill = { name: '归位', gameId: 'sokoban', description: '先把箱子推入目标。', code: '(ctx: SkillContext) => ctx.availablePushes.find(p => p.onGoal && !p.wasOnGoal)?.id ?? null' };
  const check = await (await call('/api/pets/skill/check', skill)).json();
  assert.equal(check.valid, true); assert.ok(check.tokens > 0 && check.tokens <= 100); assert.equal(check.tokenizer, 'o200k_base');
  assert.equal((await call('/api/pets/skill', { revision: 0, skill })).status, 200);
  const state = await (await call('/api/state')).json();
  assert.equal(state.mine.competition.equipped.tokens, check.tokens);
  assert.equal(state.mine.competition.equipped.code, skill.code);
  assert.equal((await call('/api/pets/skill', { revision: 1, skill: { ...skill, description: ' a'.repeat(101) } })).status, 422);
  assert.ok(!JSON.stringify(await (await call('/api/state', null, 'another-owner')).json()).includes(skill.code));
});
