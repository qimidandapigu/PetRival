import vm from 'node:vm';

// The model writes its world model as executable code. This module is the only place
// that runs it: one self-contained script, a fresh VM context, a hard timeout, and no
// host object ever crossing the boundary. Everything the script needs is inlined as
// JSON, so a sandbox escape has nothing to reach for.
export const MODEL_LIMIT = 8000;
export const TOLERANCE = Object.freeze({ x: 1.5, y: 2, vy: 1.5 });
export const DEFAULT_TIMEOUT = 1500;

function harness(source, data) {
  return `"use strict";
(function () {
const TRACES = ${JSON.stringify(data.traces)};
const LEVEL = ${JSON.stringify(data.level)};
const TOL = ${JSON.stringify(data.tolerance)};
const TASK = ${JSON.stringify(data.task)};
const START = ${JSON.stringify(data.start ?? null)};
const TARGET = ${JSON.stringify(data.target ?? null)};
const MAX_NODES = ${Number(data.maxNodes) || 0};
const HOLDS = ${JSON.stringify(data.holds)};
const result = { task: TASK, traces: [], matched: 0, frames: 0, worst: 0, mismatches: [], dead: false, plan: null, predicted: null, nodes: 0 };
function bad(message) { result.failed = message; return result; }
${source}
if (typeof step !== 'function') throw new Error('模型代码没有定义 step(state, action, level)');
function nextState(state, mask) {
  const produced = step({ x: state.x, y: state.y, vy: state.vy, grounded: state.grounded, held: state.held },
    { a: mask.a, b: mask.b, c: mask.c }, LEVEL);
  if (!produced || typeof produced !== 'object') return null;
  const next = { x: Number(produced.x), y: Number(produced.y), vy: Number(produced.vy),
    grounded: produced.grounded === true, held: produced.held === true };
  return [next.x, next.y, next.vy].every(Number.isFinite) ? next : null;
}
function frameMasks(trace) {
  const frames = [];
  for (const segment of trace.segments) for (let i = 0; i < segment.frames; i++) frames.push(segment);
  return frames;
}
function runTrace(trace) {
  const frames = frameMasks(trace), samples = trace.samples;
  if (!frames.length || !samples.length) return;
  let state = { x: samples[0].x, y: samples[0].y, vy: samples[0].vy, grounded: samples[0].grounded === true, held: false };
  const row = { id: trace.id, origin: trace.origin, matched: 0, frames: 0, dead: false, worst: 0 };
  let previousMask = null;
  for (let i = 1; i < samples.length; i++) {
    let broke = false, firstMask = null, lastMask = null;
    for (let t = samples[i - 1].t; t < samples[i].t; t++) {
      const mask = frames[t];
      if (!mask) { broke = true; break; }
      const produced = nextState(state, mask);
      if (!produced) { row.failed = 't=' + t + ' 时模型没有返回合法状态'; broke = true; break; }
      state = produced;
      if (lastMask === null) firstMask = mask;
      lastMask = mask;
      if (state.y > 470) { state.dead = true; }
    }
    if (broke) { if (row.failed && !result.failed) result.failed = row.failed + '（实验 ' + trace.id + '）'; break; }
    const actual = samples[i];
    // A real fall ends the recording: nothing after it can be compared.
    if (actual.y > 470) { row.dead = true; break; }
    const error = Math.max(Math.abs(state.x - actual.x) / TOL.x, Math.abs(state.y - actual.y) / TOL.y, Math.abs(state.vy - actual.vy) / TOL.vy);
    row.frames++;
    row.worst = Math.max(row.worst, Math.round(error * 100) / 100);
    if (error <= 1 && state.grounded === (actual.grounded === true)) row.matched++;
    else if (result.mismatches.length < 6) {
      // Telling a repair turn which input edge a divergence sits on is evidence selection,
      // not a hint: the table already contains the edge, the model just has to look there.
      const changed = previousMask && firstMask ? ['a', 'b', 'c'].filter(key => previousMask[key] !== firstMask[key]) : [];
      result.mismatches.push({ trace: trace.id, t: actual.t,
        inputChange: changed.map(function (key) { return key + ' 上一段结束时' + (previousMask[key] ? '按住' : '松开') + '，这一段开始时' + (firstMask[key] ? '按住' : '松开'); }).join('；'),
        predicted: { x: Math.round(state.x * 10) / 10, y: Math.round(state.y * 10) / 10, vy: Math.round(state.vy * 10) / 10, grounded: state.grounded },
        actual: { x: actual.x, y: actual.y, vy: actual.vy, grounded: actual.grounded === true } });
    }
    previousMask = lastMask;
  }
  if (state.y > 470) row.dead = true;
  result.matched += row.matched; result.frames += row.frames;
  result.worst = Math.max(result.worst, row.worst);
  result.traces.push(row);
}
if (TASK === 'score') { for (const trace of TRACES) { runTrace(trace); if (result.failed) break; } result.dead = result.traces.some(row => row.dead); }
if (TASK === 'plan') {
  const MASKS = []; for (let m = 0; m < 8; m++) MASKS.push({ a: !!(m & 1), b: !!(m & 2), c: !!(m & 4) });
  const heap = [], seen = new Map();
  const key = state => Math.round(state.x / 8) + ',' + state.y + ',' + (state.grounded ? 1 : 0);
  const priority = node => node.cost + Math.abs(node.state.x - TARGET.x) * 2;
  const push = node => { const id = key(node.state); if ((seen.get(id) ?? Infinity) <= node.cost) return; seen.set(id, node.cost); node.priority = priority(node); heap.push(node);
    let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j].priority <= node.priority) break; heap[i] = heap[j]; i = j; } heap[i] = node; };
  const pop = () => { const top = heap[0], end = heap.pop(); if (heap.length) { let i = 0;
    while (i * 2 + 1 < heap.length) { let j = i * 2 + 1; if (j + 1 < heap.length && heap[j + 1].priority < heap[j].priority) j++; if (end.priority <= heap[j].priority) break; heap[i] = heap[j]; i = j; } heap[i] = end; } return top; };
  push({ state: { x: START.x, y: START.y, vy: START.vy, grounded: START.grounded === true, held: false }, cost: 0, parent: null, action: null });
  while (heap.length && result.nodes++ < MAX_NODES) {
    const node = pop(), id = key(node.state);
    if (seen.get(id) < node.cost) continue;
    if (node.state.grounded && node.state.x >= TARGET.x) {
      const plan = []; for (let n = node; n.parent; n = n.parent) plan.push(...[...n.action].reverse()); plan.reverse();
      result.plan = plan; result.predicted = { x: Math.round(node.state.x * 10) / 10, y: Math.round(node.state.y * 10) / 10, vy: Math.round(node.state.vy * 10) / 10, grounded: node.state.grounded, frames: node.cost };
      break;
    }
    for (const mask of MASKS) for (const hold of HOLDS) {
      let state = node.state, actions = [], frames = 0, died = false;
      for (let i = 0; i < hold; i++) {
        const produced = nextState(state, mask);
        if (!produced) { died = true; break; }
        state = produced; frames++;
        const last = actions[actions.length - 1];
        if (last && last.a === mask.a && last.b === mask.b && last.c === mask.c) last.frames++;
        else actions.push({ a: mask.a, b: mask.b, c: mask.c, frames: 1 });
        if (state.y > 470) { died = true; break; }
      }
      if (!died && state.grounded) push({ state, cost: node.cost + frames, parent: node, action: actions });
    }
  }
}
return JSON.stringify(result);
})();
`;
}

function execute(source, data, timeoutMs) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(harness(source, data), { filename: 'jump-world-model.js' });
  return JSON.parse(script.runInContext(context, { timeout: timeoutMs, displayErrors: false }));
}
function guard(run) {
  try { return { ok: true, ...run() }; }
  catch (error) {
    const message = String(error?.message || error);
    return { ok: false, problem: message.includes('Script execution timed out') ? '模型代码运行超时（可能写了死循环）' : message.slice(0, 240) };
  }
}
export function scoreWorldModel(source, traces, level, { timeoutMs = DEFAULT_TIMEOUT, tolerance = TOLERANCE } = {}) {
  return guard(() => {
    const result = execute(source, { traces, level, task: 'score', tolerance, holds: [] }, timeoutMs);
    const error = result.frames ? (result.frames - result.matched) / result.frames : 1;
    return { matched: result.matched, frames: result.frames, error: Math.round(error * 1000) / 1000, worst: result.worst ?? 0,
      died: result.dead === true, mismatches: result.mismatches ?? [], traces: result.traces ?? [], failed: result.failed ?? null };
  });
}
export function planWithWorldModel(source, level, { start, target, timeoutMs = DEFAULT_TIMEOUT, maxNodes = 1500, holds = [6, 20, 45, 80] } = {}) {
  return guard(() => {
    if (!start || typeof start.x !== 'number' || !target || typeof target.x !== 'number') throw new Error('缺少起点或目标');
    const result = execute(source, { traces: [], level, task: 'plan', tolerance: TOLERANCE, start, target, maxNodes, holds }, timeoutMs);
    return { found: Array.isArray(result.plan) && result.plan.length > 0, plan: result.plan ?? [], predicted: result.predicted ?? null,
      nodes: result.nodes ?? 0, failed: result.failed ?? null };
  });
}
