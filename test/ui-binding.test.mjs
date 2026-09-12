import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { replay, generate } from '../shared/game.mjs';

test('polling must not multiply a preserved adoption form submission', async () => {
  // Execute the actual entrypoint's registration code. Only DOM/fetch boundaries are substituted.
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const form = new EventTarget(); form.querySelector = () => ({ disabled: false });
  const noop = { addEventListener() {}, disabled: false };
  const nodes = { '#adopt': form, '#refresh': noop, '#close-game': noop, '#game-dialog': noop, '#undo': noop, '#restart': noop, '#give-up': noop };
  let posts = 0;
  const context = vm.createContext({
    document: { querySelector: s => nodes[s] || null, querySelectorAll: () => [], addEventListener() {} },
    FormData: class { get(k) { return { name: 'Test', species: 'sprout', defense: 'on' }[k]; } },
    fetch: () => { posts++; return new Promise(() => {}); }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, console,
  });
  const code = source.slice(source.indexOf('\n') + 1, source.lastIndexOf("try { await api('/api/session'"));
  vm.runInContext(code + '\nthis.testBind = bindHome;', context);
  for (let n = 0; n < 10; n++) context.testBind();
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(posts, 1, 'one user submit must produce exactly one request after polling');
});

test('reopening a locally solved but unacknowledged run retries the verified submission', async () => {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const g = generate(56), level = { id: 'level', rows: g.rows };
  const match = { id: 'match', status: 'active', training: true, sides: [
    { own: true, pet: { id: 'mine' }, level, human: { status: 'running' } },
    { own: false, pet: { id: 'rival', name: 'Rival' } },
  ] };
  const noop = { addEventListener() {}, open: false, showModal() {} };
  let submitted = 0;
  const context = vm.createContext({ document: { querySelector: () => noop, querySelectorAll: () => [], addEventListener() {} }, localStorage: { getItem: () => g.proof }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, replay, console, match, onSubmit: () => { submitted++; } });
  const code = source.slice(source.indexOf('\n') + 1, source.lastIndexOf("try { await api('/api/session'"));
  vm.runInContext(code + '\nstate={mine:{id:"mine"}};api=async()=>match;drawBoard=()=>{};renderSide=()=>{};updateClock=()=>{};submit=async()=>onSubmit();this.testOpen=openMatch;', context);
  await context.testOpen('match');
  assert.equal(submitted, 1, 'successful moves must not be stranded when the response was lost');
});
