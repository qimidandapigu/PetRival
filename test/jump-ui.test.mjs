import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as engine from '../public/jump-engine.mjs';
import { defaultAppearance, validateAppearance, petDisplayName } from '../shared/pet.mjs';

test('keyboard demonstration updates the local notebook and resumes the waiting pet to completion', async () => {
  const nodes = new Map(), events = new Map(), saved = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', value: id === '#camera' ? 'human' : '0', hidden: true,
      addEventListener(type, handler) { this[type] = handler; }, focus() {}, closest() { return null; },
      replaceChildren() {}, getContext() { return {}; }, dataset: {}, clientWidth: 900 });
    return nodes.get(id);
  }
  const context = vm.createContext({ ...engine, defaultAppearance, validateAppearance, petDisplayName,
    document: { querySelector: node, querySelectorAll: () => [], addEventListener: (type, handler) => events.set(type, handler), createElement: () => ({}) },
    window: { addEventListener() {} }, requestAnimationFrame() {}, AbortSignal,
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetch: async () => ({ ok: true, json: async () => ({ mine: { id: 'test-pet', name: '小精灵', species: 'xiaotangyuan' } }) }),
  });
  const source = readFileSync(new URL('../public/jump.mjs', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
  vm.runInContext(source + '\nthis.fixture = { advance, teach, resetLevel, get: () => ({human,pet,waiting,memory,progress,humanCheckpoint,petCheckpoint,paused}) };', context);
  await new Promise(resolve => setImmediate(resolve));
  const api = context.fixture, key = (type, code) => events.get(type)({ code, target: node('#jump-canvas'), preventDefault() {} });
  for (let i = 0; i < 200; i++) api.advance();
  assert.equal(api.get().waiting, true);
  assert.equal(api.get().memory.clips.length, 0);
  api.teach(); key('keydown', 'ArrowRight');
  while (api.get().human.x < 336) api.advance();
  key('keydown', 'Space');
  for (let i = 0; i < 50; i++) api.advance();
  key('keyup', 'Space'); key('keyup', 'ArrowRight');
  assert.equal(api.get().memory.clips.length, 1);
  assert.equal(api.get().waiting, false);
  assert.equal(JSON.parse(saved.get('petrival.jump.v1.pet.test-pet')).clips.length, 1);
  for (let i = 0; i < 400; i++) api.advance();
  assert.equal(api.get().progress.won, true);
  assert.equal(node('#finish').hidden, false);
  api.resetLevel(1);
  assert.equal(api.get().memory.clips.length, 1, 'changing level keeps learned demonstrations');
  for (let i = 0; i < 600; i++) api.advance();
  assert.equal(api.get().progress.won, true);
});
