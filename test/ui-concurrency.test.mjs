import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function ui() {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const events = new Map();
  const practice = { disabled: false, addEventListener(type, handler) { events.set(type, handler); }, removeEventListener(type) { events.delete(type); } };
  const noop = { disabled: false, open: false, textContent: '', hidden: false, classList: { toggle() {} }, addEventListener() {}, removeEventListener() {}, showModal() { this.open = true; } };
  const context = vm.createContext({
    document: { hidden: false, querySelector: selector => selector === '#practice-ai' ? practice : noop, querySelectorAll: () => [], addEventListener() {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, console,
  });
  const code = source.slice(source.indexOf('\n') + 1, source.lastIndexOf("try { await api('/api/session'"));
  vm.runInContext(code + `
    state = { mine: { id: 'mine', name: '小汤圆', level: { id: 'cached-level' } } };
    drawBoard = () => {}; renderSide = () => {}; drawAgent = () => {}; updateClock = () => {}; refresh = async () => {};
    this.poll = pollMatch; this.finish = submit; this.openPractice = openPractice;
    this.getGame = () => game; this.setGame = value => { game = value; };
    this.setApi = handler => { api = handler; }; this.testBind = bindHome;
  `, context);
  return { context, practice, start: () => events.get('click')({ currentTarget: practice }) };
}
function match(status = 'running') {
  return { id: 'match', status: 'active', sides: [{ own: true, human: { status } }] };
}

test('a delayed pre-finish poll cannot restore an already submitted human run', async () => {
  const { context } = ui(), pendingPoll = deferred();
  context.setGame({ kind: 'challenge', id: 'match', actions: '', match: match() });
  const accepted = match('failed');
  context.setApi(path => path.endsWith('/finish') ? Promise.resolve(accepted) : pendingPoll.promise);
  const polling = context.poll();
  await context.finish(true);
  assert.equal(context.getGame().match.sides[0].human.status, 'failed');
  pendingPoll.resolve(match()); await polling;
  assert.equal(context.getGame().match.sides[0].human.status, 'failed', 'an old GET must not reopen the controls after accepted finish');
});

test('a delayed poll for a closed challenge cannot replace the next game', async () => {
  const { context } = ui(), pendingPoll = deferred();
  context.setGame({ kind: 'challenge', id: 'match', actions: '', match: match() });
  context.setApi(() => pendingPoll.promise);
  const polling = context.poll();
  const nextGame = { kind: 'practice', level: { id: 'new-practice' }, actions: 'UR' };
  context.setGame(null); context.setGame(nextGame);
  pendingPoll.resolve(match('failed')); await polling;
  assert.equal(context.getGame(), nextGame); assert.equal(context.getGame().actions, 'UR');
});

test('AI practice opens a playable board only after its locked level snapshot is known', async () => {
  const { context, practice, start } = ui(), startup = deferred();
  context.setApi(() => startup.promise); context.testBind();
  const request = start();
  assert.equal(practice.disabled, true);
  assert.equal(context.getGame(), null, 'do not accept human moves on a cached board that startup would reset');
  const lockedLevel = { id: 'locked-server-level' };
  startup.resolve({ id: 'practice', level: lockedLevel, run: { status: 'running', actions: '' } });
  await request;
  assert.equal(context.getGame().level, lockedLevel);
  assert.equal(context.getGame().actions, ''); assert.equal(context.getGame().practiceId, 'practice');
  assert.equal(practice.disabled, false);
});

test('AI practice startup cannot take over a different practice opened while waiting', async () => {
  const { context, start } = ui(), startup = deferred();
  context.setApi(() => startup.promise); context.testBind();
  const request = start();
  context.openPractice({ id: 'manual-practice' }); context.getGame().actions = 'UR';
  const chosenGame = context.getGame();
  startup.resolve({ id: 'old-request', level: { id: 'old-level' }, run: { status: 'running', actions: '' } });
  await request;
  assert.equal(context.getGame(), chosenGame); assert.equal(context.getGame().actions, 'UR');
});
