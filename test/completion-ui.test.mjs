import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generate, replay, renderRows, RULES } from '../shared/game.mjs';

const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8').replace(/^import.*$/gm, '');
const context = vm.createContext({ Date });
vm.runInContext(source.slice(source.indexOf('function completionView('), source.indexOf('function drawCompletion(')) + '\nthis.view = completionView;', context);
const won = { won: true, steps: 11 };
const challenge = (human = {}, status = 'active') => ({ kind: 'challenge', match: { status, sides: [{ own: true, human: { status: 'running', ...human } }] } });

test('a local solution is visibly celebrated without inventing server confirmation or a team win', () => {
  const current = challenge();
  let view = context.view(current, won, true);
  assert.equal(view.confirmed, false); assert.equal(view.elapsedMs, null); assert.match(view.note, /确认/);
  current.finishError = '离线'; view = context.view(current, won, false);
  assert.equal(view.action, 'retry'); assert.match(view.note, /暂未确认.*已保留/);
  current.match.sides[0].human = { status: 'cleared', elapsedMs: 4321 };
  view = context.view(current, won, false);
  assert.equal(view.confirmed, true); assert.equal(view.elapsedMs, 4321); assert.equal(view.steps, 11);
  assert.equal(view.title, '你已通关！'); assert.match(view.note, /其他参与者继续/);
  current.match.status = 'done'; current.match.winner = 'opponent';
  assert.equal(context.view(current, won, false).title, '你已通关！', 'individual success does not claim the team won');
});

test('server failure or a voided match takes precedence over locally solved boxes', () => {
  assert.equal(context.view(challenge({ status: 'failed' }), won, false), null);
  assert.equal(context.view(challenge({ status: 'cleared' }, 'void'), won, false), null);
  assert.equal(context.view({ kind: 'replay' }, won, false), null);
  assert.equal(context.view(challenge(), { won: false, steps: 10 }, false), null);
});

test('practice completion displays its frozen elapsed time and remains unranked', () => {
  const view = context.view({ kind: 'practice', startedAt: 1000, completedAt: 5100 }, won, false);
  assert.equal(view.elapsedMs, 4100); assert.equal(view.action, 'restart'); assert.match(view.note, /不计排名/);
});

test('actual gameplay shows the completion card once, preserves dismissal on redraw, and clears it on restart', async () => {
  let now = 1000;
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { id: selector.slice(1), hidden: false, textContent: '', innerHTML: '', open: false, disabled: false,
      events: {}, classList: { toggle() {} }, addEventListener(name, fn) { this.events[name] = fn; }, querySelectorAll() { return []; }, showModal() { this.open = true; } });
    return nodes.get(selector);
  };
  const ctx = vm.createContext({ document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, console, replay, renderRows, RULES,
    petMarkup: () => '<svg></svg>', Date: class extends Date { static now() { return now; } } });
  vm.runInContext(source.slice(source.indexOf('\n') + 1, source.lastIndexOf("try { await api('/api/session'")) + '\nstate={mine:{name:"团子"},mode:"algorithm"}; this.start=openPractice;this.move=act;this.redraw=drawBoard;this.current=()=>game;', ctx);
  const level = generate(56); ctx.start(level);
  assert.equal(node('#completion').hidden, true);
  now = 5100;
  for (const action of level.proof) await ctx.move(action);
  assert.equal(node('#completion').hidden, false); assert.match(node('#completion-title').textContent, /通关/);
  assert.equal(node('#completion-time').textContent, '00:04');
  node('#completion-dismiss').events.click(); ctx.redraw();
  assert.equal(node('#completion').hidden, true);
  now = 8000; await ctx.move('X');
  assert.equal(ctx.current().actions, ''); assert.equal(ctx.current().startedAt, 8000);
  assert.equal(node('#completion').hidden, true); assert.doesNotMatch(node('#result-card').innerHTML, /试玩通关/);
  now = 11000; for (const action of level.proof) await ctx.move(action);
  assert.equal(node('#completion').hidden, false); assert.equal(node('#completion-time').textContent, '00:03');
});
