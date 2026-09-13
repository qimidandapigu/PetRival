import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('shared homepage challenges the selected game while retaining the pet identity', async () => {
  const events = new Map(), requests = [], opened = [];
  const noop = { addEventListener() {}, removeEventListener() {} };
  const rival = { dataset: { challenge: 'rival' }, addEventListener(type, handler) { events.set(type, handler); } };
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8').replace(/^import.*$/gm, '');
  const context = vm.createContext({
    document: { querySelector: () => noop, querySelectorAll: selector => selector === '[data-challenge]' ? [rival] : [], addEventListener() {} },
    setInterval() {}, console,
    openBoxing: async match => opened.push(['boxing', match.id]),
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("try { await api('/api/session'")) + `
    state = { mine: { id: 'same-pet', selectedGame: 'boxing' } };
    refresh = async () => {};
    this.testBind = bindHome;
    this.mine = () => state.mine;
    this.setApi = f => { api = f; };
    this.setOpenMatch = f => { openMatch = f; };
  `, context);
  context.setApi(async (path, body) => { requests.push({ path, body }); return { id: 'match' }; });
  context.setOpenMatch(async id => opened.push(['sokoban', id]));
  const mine = context.mine();
  context.testBind();
  await events.get('click')();
  assert.equal(requests.at(-1).path, '/api/boxing');
  assert.equal(requests.at(-1).body.opponentId, 'rival');
  assert.deepEqual(opened.at(-1), ['boxing', 'match']);
  mine.selectedGame = 'sokoban';
  await events.get('click')();
  assert.equal(requests.at(-1).path, '/api/challenges');
  assert.deepEqual(opened.at(-1), ['sokoban', 'match']);
  assert.equal(context.mine(), mine);
  assert.equal(context.mine().id, 'same-pet');
});
