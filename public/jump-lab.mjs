// Blank-slate lab. The pet is told nothing about this world: not which channel jumps,
// not how strong gravity is, not what the goal is. Everything below is either a hidden
// world fact, a free engine experiment, or a recorded observation. Only the last two are
// ever handed to a model, and the seed that generated the hidden facts is never sent.
import { PHYSICS, actor, progress, step, validateLevel, verifyLevel } from './jump-world.mjs';

export const CHANNELS = Object.freeze(['a', 'b', 'c']);
export const ROLES = Object.freeze(['left', 'right', 'jump']);
// Plausible platformer numbers, drawn once per world and never written into a prompt.
export const RANGES = Object.freeze({ speed: [2.8, 3.8], gravity: [.45, .65], jump: [-13.5, -10.5], cut: [-6.5, -2.5] });
export const MAX_TRACES = 60, MAX_NOTEBOOK = 24, CONFIRM_EVIDENCE = 3, SAMPLE_EVERY = 1, DENSE_FRAMES = 0, MAX_TRACE_FRAMES = 600;
// Where a world-model plan tries to get to: just past the pit on the right platform.
export const LAB_PLAN_TARGET = 520;
export const TRACE_ORIGINS = Object.freeze(['engine', 'human', 'self']);

const round1 = v => Math.round(v * 10) / 10;
// Samples keep three decimals: the constants of a world (per-frame speed, gravity, jump
// impulse) have to be readable from the differences of consecutive frames, and rounding
// them to a tenth makes an exactly reproducible model impossible to write.
const exact = v => Math.round(v * 1000) / 1000;

export function validatePhysics(raw) {
  const physics = {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = raw?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`物理参数 ${key} 无效`);
    if (value < min || value > max) throw new Error(`物理参数 ${key} 不在允许区间`);
    physics[key] = value;
  }
  return { ...physics, radius: PHYSICS.radius, height: PHYSICS.height, fps: PHYSICS.fps };
}

// splitmix32: small integer seeds must not collide on the first draws.
function rng(seed) {
  let s = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s; t ^= t >>> 16; t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}
const draw = (random, key) => { const [min, max] = RANGES[key]; return Math.round((min + random() * (max - min)) * 100) / 100; };

// One layout, easy to walk and impossible to cross without knowing the channels.
// Every parameter draw inside RANGES must leave it solvable; see test/jump-lab.test.mjs.
export function labLevel() {
  return validateLevel({ version: 2, title: '空白的第一个世界', width: 900, spawn: { x: 64, y: 400 }, goal: { x: 852, y: 400 },
    platforms: [{ x: 0, y: 400, w: 336 }, { x: 400, y: 400, w: 500 }, { x: 96, y: 336, w: 112 }],
    coins: [{ x: 152, y: 324 }, { x: 520, y: 388 }], key: { x: 448, y: 388 }, switch: { x: 176, y: 388 }, door: { x: 720, y: 152, h: 248 } });
}
export function labWorld(seed = 1) {
  const id = Math.abs(Math.trunc(Number(seed))) % 100000 || 1, random = rng(id);
  const roles = [...ROLES];
  for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  return { seed: id, level: labLevel(), physics: validatePhysics(Object.fromEntries(Object.keys(RANGES).map(k => [k, draw(random, k)]))),
    mapping: Object.fromEntries(CHANNELS.map((channel, i) => [channel, roles[i]])) };
}
// Only the player-facing reveal and the tests read this.
export function hiddenTruth(world) { return { seed: world.seed, mapping: { ...world.mapping }, physics: { ...world.physics } }; }

export function validateChannelActions(raw, maxFrames = 240, maxSegments = 12) {
  if (!Array.isArray(raw) || !raw.length || raw.length > maxSegments) throw new Error(`动作应为 1–${maxSegments} 段`);
  let total = 0;
  const actions = raw.map(action => {
    if (!action || CHANNELS.some(c => typeof action[c] !== 'boolean') || !Number.isInteger(action.frames) || action.frames < 1 || action.frames > 90)
      throw new Error('动作需要 a/b/c 三个布尔通道，frames=1–90');
    total += action.frames;
    return { a: action.a === true, b: action.b === true, c: action.c === true, frames: action.frames };
  });
  if (total > maxFrames) throw new Error(`动作总长度超过 ${maxFrames} 帧`);
  return actions;
}
// The only place the hidden mapping turns a channel mask into engine input.
export function channelInput(world, action) {
  const roles = CHANNELS.filter(channel => action[channel] === true).map(channel => world.mapping[channel]);
  return { move: (roles.includes('right') ? 1 : 0) - (roles.includes('left') ? 1 : 0), jump: roles.includes('jump') };
}
// The human presses roles; a recorded demonstration becomes a channel trace through here.
export function roleInputToChannels(world, input) {
  const active = input.jump ? ['jump'] : input.move === -1 ? ['left'] : input.move === 1 ? ['right'] : [];
  return Object.fromEntries(CHANNELS.map(channel => [channel, active.includes(world.mapping[channel])]));
}

const snapshot = a => ({ x: exact(a.x), y: exact(a.y), vy: exact(a.vy), grounded: a.grounded === true });
export function runExperiment(world, { id, segments, origin = 'engine', start = null, note = '', role = 'pet' }) {
  const proto = validateChannelActions(segments, MAX_TRACE_FRAMES);
  const a = start ? { ...start } : actor(world.level.spawn), p = progress();
  const samples = [{ t: 0, ...snapshot(a) }];
  let t = 0;
  for (const segment of proto) for (let i = 0; i < segment.frames && !a.dead; i++) {
    step(a, channelInput(world, segment), world.level, p, role, world.physics);
    // Every frame is recorded. Landing and the release-shortened jump both happen inside a
    // single frame, so a sparser table hides exactly the two rules hardest to guess.
    if (++t <= DENSE_FRAMES || t % SAMPLE_EVERY === 0) samples.push({ t, ...snapshot(a) });
  }
  if (samples.at(-1).t !== t) samples.push({ t, ...snapshot(a) });
  // Trailing frames where nothing changes (standing still after landing) carry no evidence
  // and would dominate the prompt; keep a few so "held 75 frames and did not move" stays visible.
  while (samples.length > 3) {
    const last = samples.at(-1), before = samples.at(-2);
    if (last.grounded && before.grounded && last.x === before.x && last.y === before.y && last.vy === before.vy) samples.pop();
    else break;
  }
  const first = samples[0], last = samples.at(-1);
  return { id: String(id).slice(0, 60), origin: TRACE_ORIGINS.includes(origin) ? origin : 'engine', note: String(note).slice(0, 120), segments: proto,
    frames: t, dead: a.dead === true, samples, delta: { x: round1(last.x - first.x), y: round1(last.y - first.y) },
    progress: { coins: [...p.coins], key: p.key, switchOn: p.switchOn, won: p.won } };
}
// Each channel alone for one tap and one long hold, then every pair. No model call needed.
export function experimentBattery(world) {
  const seg = (on, frames) => ({ a: on.includes('a'), b: on.includes('b'), c: on.includes('c'), frames });
  const plans = [];
  for (const channel of CHANNELS) {
    plans.push([`${channel}-tap`, [seg(channel, 6), seg('', 45)], `${channel} 只按 6 帧就松开`]);
    plans.push([`${channel}-hold`, [seg(channel, 60), seg('', 30)], `${channel} 一直按住 60 帧`]);
  }
  for (const [x, y] of [['a', 'b'], ['a', 'c'], ['b', 'c']])
    plans.push([`${x}${y}-hold`, [seg(x + y, 45), seg('', 30)], `${x} 与 ${y} 一起按住 45 帧`]);
  return plans.map(([id, segments, note]) => runExperiment(world, { id: `eng-${id}`, segments, note }));
}
export function summarizeTraces(traces, limit = 10) {
  return (Array.isArray(traces) ? traces : []).slice(-limit).map(({ id, origin, note, segments, frames, dead, samples, delta }) =>
    ({ id, origin, note, frames, dead, delta, segments, samples }));
}

export const STATES = Object.freeze(['猜想', '观察', '确认', '已推翻']);
export function summarizeNotebook(notebook) {
  return (Array.isArray(notebook) ? notebook : []).slice(-MAX_NOTEBOOK).map(({ id, claim, state, scope, evidence, confidence }) =>
    ({ id, claim, state, scope, evidence, confidence }));
}
// Evidence for induction: geometry, the experimenter's own inputs, what happened.
export function labEvidence({ world, label, traces, notebook = [] }) {
  return { world: { name: label, level: world.level }, channels: [...CHANNELS],
    notebook: summarizeNotebook(notebook), experiments: summarizeTraces(traces, 10) };
}
// Observation for acting: current state plus the distilled notebook, not the raw traces.
export function labObservation({ world, label, actor: a, progress: p, notebook = [], feedback = '', note = '' }) {
  return { world: { name: label, level: world.level }, channels: [...CHANNELS],
    pet: { x: round1(a.x), y: round1(a.y), vy: round1(a.vy), grounded: a.grounded === true, held: a.held === true },
    progress: { coins: [...p.coins], key: !!p.key, switchOn: !!p.switchOn, won: !!p.won },
    notebook: summarizeNotebook(notebook), lastResult: String(feedback || '').slice(0, 300), teacherNote: String(note || '').slice(0, 200) };
}
// Promotion to 确认 is counted from real evidence ids here, never taken from the model's word.
export function reduceNotebook(notebook, ops, evidenceIds) {
  const known = new Set((Array.isArray(evidenceIds) ? evidenceIds : []).map(String));
  const adjusted = [], byId = new Map();
  let minted = 0;
  for (const entry of Array.isArray(notebook) ? notebook : []) if (entry && typeof entry.id === 'string') byId.set(entry.id, { ...entry, evidence: [...(entry.evidence || [])] });
  for (const raw of (Array.isArray(ops) ? ops : []).slice(0, 12)) {
    const claim = typeof raw?.claim === 'string' ? raw.claim.trim().slice(0, 160) : '';
    if (!claim) { adjusted.push('缺少结论文字'); continue; }
    const evidence = [...new Set((Array.isArray(raw.evidence) ? raw.evidence : []).map(String).filter(id => known.has(id)))];
    const asked = STATES.includes(raw.state) ? raw.state : '猜想';
    const previous = typeof raw?.id === 'string' ? byId.get(raw.id) : null;
    const id = typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 60) : `note-${byId.size}-${++minted}`;
    const merged = [...new Set([...(previous?.evidence || []), ...evidence])];
    const state = asked === '已推翻' && merged.length ? '已推翻' : merged.length >= CONFIRM_EVIDENCE ? '确认' : merged.length ? '观察' : '猜想';
    const askedConfidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : .5;
    byId.set(id, { id, claim, state, scope: typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim().slice(0, 40) : '这个世界',
      evidence: merged, confidence: Math.round(Math.min(state === '确认' ? 1 : .8, Math.max(0, askedConfidence)) * 100) / 100 });
    if (state !== asked) adjusted.push(`${claim.slice(0, 20)}：证据 ${merged.length} 条，按证据记为${state}（模型自报${asked}）`);
  }
  const list = [...byId.values()].slice(-MAX_NOTEBOOK);
  return { notebook: list, adjusted, confirmed: list.filter(e => e.state === '确认').length };
}

export function validatePrediction(raw) {
  if (!raw || !['up', 'down', 'level'].includes(raw.dy) || typeof raw.grounded !== 'boolean' || typeof raw.dead !== 'boolean')
    throw new Error('预测需要 dy=up/down/level、grounded、dead');
  return { dy: raw.dy, grounded: raw.grounded, dead: raw.dead };
}
export function scorePrediction(prediction, before, after, dead) {
  const delta = after.y - (before?.y ?? after.y);
  const actual = { dy: delta < -1 ? 'up' : delta > 1 ? 'down' : 'level', grounded: after.grounded === true, dead: dead === true };
  const fields = ['dy', 'grounded', 'dead'];
  return { actual, hits: fields.filter(k => actual[k] === prediction[k]).length, total: fields.length,
    missed: fields.filter(k => actual[k] !== prediction[k]) };
}
export function scorePriorGuesses(guesses, world) {
  const rows = CHANNELS.map(channel => {
    const guess = (Array.isArray(guesses) ? guesses : []).find(g => g?.channel === channel) || { role: 'unknown', confidence: 0 };
    const role = ROLES.includes(guess.role) ? guess.role : 'unknown';
    const confidence = typeof guess.confidence === 'number' && Number.isFinite(guess.confidence) ? Math.min(1, Math.max(0, guess.confidence)) : 0;
    return { channel, guessed: role, actual: world.mapping[channel], hit: role === world.mapping[channel], confidence };
  });
  return { rows, hits: rows.filter(r => r.hit).length, total: CHANNELS.length };
}
// A handed-out world must stay solvable for every parameter draw in RANGES.
export function verifyLabWorld(world, { samples = 5, maxNodes = 9000 } = {}) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1), physics = {};
    for (const [key, [min, max]] of Object.entries(RANGES)) physics[key] = min + (max - min) * t;
    const proof = verifyLevel(world.level, { physics: validatePhysics(physics), maxNodes });
    results.push({ ratio: t, verified: proof.verified, visited: proof.visited });
  }
  return { verified: results.every(r => r.verified), results };
}

// ---- 学习日志与「它现在会什么」 ----
export const MAX_LOG = 160;
export const ROLE_WORDS = Object.freeze({ left: '左', right: '右', jump: '跳' });
// A log line is plain data: the page renders it, nothing infers from it. `kind` groups the
// steps so the player can see which of them cost a model call and which were free.
export function logLine(kind, text) {
  return { at: Number.isFinite(Date.now()) ? Date.now() : 0, kind: String(kind).slice(0, 20), text: String(text).slice(0, 300) };
}
// What the pet can claim right now, in plain language. Every line comes from evidence the
// server counted (confirmed notebook entries, engine-scored frames, scored predictions),
// never from a model's own summary of itself.
export function summarizeKnowledge({ notebook = [], worldModel = null, plan = null, modelRuns = [], accuracy = { hits: 0, total: 0 }, answer = null } = {}) {
  const notes = summarizeNotebook(notebook);
  const confirmed = notes.filter(n => n.state === '确认');
  const channels = CHANNELS.map(channel => {
    const claims = confirmed.filter(n => n.claim.includes(channel)).map(n => n.claim);
    const actual = answer?.mapping?.[channel] ?? null;
    return { channel, claims, known: claims.length > 0, actual, agrees: actual && claims.length ? claims.some(claim => claim.includes(ROLE_WORDS[actual])) : null };
  });
  const lines = [];
  if (!confirmed.length && !worldModel) lines.push('还什么都不会：没有一条机制达到「确认」，也没有通过验证的世界模型。');
  if (worldModel?.verified) lines.push(`能逐帧预测这个世界：代码跑通 ${worldModel.frames} 帧、误差 0。`);
  else if (worldModel) lines.push(`世界模型还没对上：${worldModel.frames} 帧里对上 ${worldModel.matched} 帧，所以不能拿它规划。`);
  if (plan?.actions?.length) lines.push(`模型里搜出了到 x=${plan.target} 的路线（${plan.actions.length} 段），但只有真引擎跑通才算数。`);
  if (modelRuns.length) lines.push(`模型规划在真世界 ${modelRuns.filter(r => r.hit).length}/${modelRuns.length} 次成立。`);
  if (accuracy.total) lines.push(`行动预测命中 ${accuracy.hits}/${accuracy.total}（${Math.round(accuracy.hits / accuracy.total * 100)}%）。`);
  return { channels, unknown: channels.filter(c => !c.known).map(c => c.channel), lines, confirmed: confirmed.length,
    hypotheses: notes.filter(n => n.state === '猜想').length, pending: notes.filter(n => n.state === '观察').length,
    refuted: notes.filter(n => n.state === '已推翻').length };
}
