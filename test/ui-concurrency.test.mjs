import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generate, replay, renderRows, RULES } from '../shared/game.mjs';

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

test('an opponent replay animates only the AI lane and keeps that pet identity in the summary', () => {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8'), nodes = new Map();
  let advance;
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { textContent: '', innerHTML: '', open: false, classes,
        classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
        addEventListener() {}, showModal() { this.open = true; }, querySelectorAll() { return []; } });
    }
    return nodes.get(selector);
  }
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    petMarkup: pet => `<svg data-pet="${pet.id}"></svg>`, replay, renderRows, RULES,
    setInterval(callback) { advance = callback; return 1; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  const code = source.slice(source.indexOf('\n') + 1, source.lastIndexOf("try { await api('/api/session'"));
  vm.runInContext(code + `
    state = { mine: { id: 'mine', name: '我的宠物' }, mode: 'model', model: 'deepseek-v4-pro' };
    this.playReplay = openReplay; this.currentGame = () => game;
  `, context);
  const level = generate(56), opponent = { id: 'opponent', name: '对手小狐狸', species: 'fox' };
  context.playReplay(level, level.proof, '对手小狐狸 · 挑战回放', '算法 AI · 已通关', opponent, { method: 'algorithm' });
  for (let i = 0; i < level.proof.length; i++) advance();
  assert.equal(context.currentGame().actions, '', 'AI replay must never use the human action stream');
  assert.equal(context.currentGame().replayActions, level.proof);
  assert.equal(node('#agent-name').textContent, '对手小狐狸 · AI');
  assert.equal(node('#agent-status').textContent, '已通关');
  assert.match(node('#agent-board').innerHTML, /data-pet="opponent"/);
  assert.ok(node('#game-dialog').classes.has('replay-mode'), 'the inactive human lane is hidden in replay mode');
  assert.match(node('#agent-card').innerHTML, /对手小狐狸/, 'the summary must describe the replayed pet');
  assert.doesNotMatch(node('#agent-card').innerHTML, /我的宠物/);
  assert.equal(node('#agent-model').textContent, '算法 AI', 'algorithm replay must not inherit the currently configured model badge');
  context.playReplay(level, level.proof, '对手小狐狸 · 挑战回放', '大模型 · 已通关', opponent, { method: 'model', model: 'recorded-model' });
  assert.equal(node('#agent-model').textContent, 'recorded-model', 'model replay uses its recorded provider model');
});
