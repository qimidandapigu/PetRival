import { starterLevel, actor, step, progress as freshProgress, validateLevel, validateActions, PHYSICS } from './jump-world.mjs';
import { labWorld, experimentBattery, runExperiment, roleInputToChannels, channelInput, summarizeNotebook, scorePrediction, scorePriorGuesses, hiddenTruth, validateChannelActions, MAX_TRACES, LAB_PLAN_TARGET, MAX_LOG, logLine, summarizeKnowledge } from './jump-lab.mjs';
import { defaultAppearance, validateAppearance, petDisplayName } from '/shared/pet.mjs';
const $ = s => document.querySelector(s), canvas = $('#jump-canvas'), ctx = canvas.getContext('2d');
let level = starterLevel(), human = actor(level.spawn), pet = actor(level.spawn), progress = freshProgress();
let appearance = defaultAppearance('xiaotangyuan'), petName = '小精灵', storageKey = 'petrival.jump.v2.guest';
let samples = [], recording = null, enabled = false, pending = false, paused = false, ready = false, epoch = 0, abort;
let queue = [], calls = 0, falls = 0, tick = 0, cameraX = 0, previousTime = 0, accumulator = 0;
let status = '你可以先练习。点击开始后，真实模型才会决定精灵的动作。', feedback = '', planStart, prepared = null;
// Blank lab: this world's channel roles and physics exist only in `lab.world`, and `mode`
// decides whether the model is playing a designed level or learning from scratch.
let mode = 'classic', labStorageKey = 'petrival.jump.lab.v1.guest';
let lab = { index: 1, seed: 0, world: null, notebook: [], traces: [], prior: null, priorScore: null, answer: null,
  pending: null, lastScore: null, accuracy: { hits: 0, total: 0 }, stats: [], calls: 0, adjusted: [], worldModel: null, plan: null, modelRuns: [], log: [] };
let modelPlan = null;
// The log is the only place the player can see what actually happened, so every step writes
// a line here: free engine work, paid model calls, what changed, and what it cost.
function logEvent(kind, text) {
  lab.log = [...(lab.log || []), logLine(kind, text)].slice(-MAX_LOG);
}
const physics = () => mode === 'lab' && lab.world ? lab.world.physics : PHYSICS;
const keys = { left: false, right: false, jump: false }, keyboard = new Set(), pointers = new Map();
const idle = () => { keyboard.clear(); pointers.clear(); keys.left = keys.right = keys.jump = false; };
function syncKeys() { for (const key of Object.keys(keys)) keys[key] = keyboard.has(key) || [...pointers.values()].includes(key); }
async function api(path, data, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || '服务暂不可用'); return result;
}
function save() { try { localStorage.setItem(storageKey, JSON.stringify(samples)); } catch { $('#save-note').textContent = '本浏览器无法保存示范；关页后可能丢失。'; } }
function saveLab() {
  try { localStorage.setItem(labStorageKey, JSON.stringify({ index: lab.index, seed: lab.seed, notebook: summarizeNotebook(lab.notebook),
    traces: lab.traces.slice(-MAX_TRACES), accuracy: lab.accuracy, stats: lab.stats.slice(-8), calls: lab.calls,
    worldModel: lab.worldModel, plan: lab.plan, modelRuns: (lab.modelRuns || []).slice(-8), log: (lab.log || []).slice(-MAX_LOG) })); }
  catch { $('#save-note').textContent = '本浏览器无法保存机制手册；关页后可能丢失。'; }
}
function loadLab(stored) {
  if (!stored || !Number.isInteger(stored.seed) || stored.seed <= 0) return;
  lab = { ...lab, index: Number.isInteger(stored.index) && stored.index > 0 ? stored.index : 1, seed: stored.seed, world: labWorld(stored.seed),
    notebook: summarizeNotebook(stored.notebook), traces: (Array.isArray(stored.traces) ? stored.traces : []).slice(-MAX_TRACES),
    stats: Array.isArray(stored.stats) ? stored.stats.slice(-8) : [], calls: Number.isInteger(stored.calls) ? stored.calls : 0,
    accuracy: stored.accuracy && Number.isInteger(stored.accuracy.hits) && Number.isInteger(stored.accuracy.total) ? stored.accuracy : { hits: 0, total: 0 },
    worldModel: stored.worldModel && typeof stored.worldModel.code === 'string' ? stored.worldModel : null,
    plan: stored.plan && Array.isArray(stored.plan.actions) ? stored.plan : null,
    modelRuns: Array.isArray(stored.modelRuns) ? stored.modelRuns.slice(-8) : [],
    log: (Array.isArray(stored.log) ? stored.log : []).filter(e => e && typeof e.text === 'string').slice(-MAX_LOG) };
}
async function init() {
  try {
    await api('/api/session', {}, AbortSignal.timeout(5000));
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(5000) });
    if (response.ok) { const state = await response.json(); if (state.mine) {
      storageKey = `petrival.jump.v2.pet.${state.mine.id}`; petName = petDisplayName(state.mine.name);
      try { appearance = validateAppearance(state.mine.appearance || defaultAppearance(state.mine.species)); } catch {}
    } }
  } catch { status = '账号服务暂不可用；你仍能练习，模型开始时会提示连接结果。'; }
  labStorageKey = storageKey.replace('jump.v2', 'jump.lab.v1');
  try { const stored = JSON.parse(localStorage.getItem(storageKey) || '[]'); samples = (Array.isArray(stored) ? stored : []).slice(-8).filter(d => { try { validateLevel(d.level); validateActions(d.actions); return d.from && d.to; } catch { return false; } }); } catch {}
  try { loadLab(JSON.parse(localStorage.getItem(labStorageKey) || 'null')); } catch {}
  ready = true; update();
}
function cancel() { epoch++; abort?.abort(); pending = false; enabled = false; queue = []; }
function resetLevel(next = level) {
  cancel(); idle(); recording = null; level = validateLevel(next); human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress();
  calls = falls = 0; feedback = ''; paused = false; $('#soundless-pause').textContent = '暂停'; status = '关卡已锁定。点击开始，让模型自己尝试。'; update();
}
async function decide() {
  if (!enabled || pending || paused || recording || progress.won || pet.dead) return;
  if (calls >= 16) { enabled = false; status = '本轮已调用 16 次模型，暂停节省额度。可以示范后再继续。'; update(); return; }
  const learning = mode === 'lab';
  pending = true; calls++; const current = epoch; abort = new AbortController(); planStart = { ...pet };
  status = learning ? '模型正在看这个世界的实验记录和它的机制手册；你可以继续移动。' : '模型正在观察关卡和你的示范；你可以继续移动。'; update();
  try {
    const result = await api(learning ? '/api/jump/lab/plan' : '/api/jump/decision',
      learning ? { world: { name: `世界 ${lab.index}`, level }, actor: pet, progress, notebook: lab.notebook, note: $('#teacher-note').value, feedback }
        : { level, actor: pet, progress, demonstrations: samples.slice(-4), note: $('#teacher-note').value, feedback },
      AbortSignal.any([abort.signal, AbortSignal.timeout(100000)]));
    if (current !== epoch) return;
    if (result.method !== 'model') throw new Error('接口未返回真实模型动作，已暂停');
    queue = (learning ? validateChannelActions(result.actions) : validateActions(result.actions)).map(a => ({ ...a }));
    if (learning) {
      lab.calls++; lab.pending = result.prediction ? { prediction: result.prediction, start: { ...pet } } : null;
      logEvent('act', `第 ${calls} 次决策（累计第 ${lab.calls} 次模型调用）：它给出 ${queue.length} 段按键、目标「${result.goal || '试探'}」，参考手册 ${result.notesProvided} 条${result.prediction ? '，并先下了预测' : '，没有给预测'}`);
      saveLab(); update();
    }
    status = learning
      ? `${result.model}：${result.goal || '试探这个世界'} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 手册 ${result.notesProvided} 条（未确认 ${result.unconfirmed}）· ${result.prediction ? '已先下预测' : '这次没给预测'}`
      : `${result.model}：${result.goal || '执行下一段动作'} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 参考 ${result.usedDemonstrations.length}/${result.demonstrationsProvided} 次示范`;
  } catch (e) { if (current === epoch) { enabled = false; logEvent('error', `决策失败：${e.name === 'TimeoutError' ? '模型等待超时' : e.message}`); saveLab(); status = `${e.name === 'TimeoutError' ? '模型等待超时' : e.message}；真人可继续，点击开始重试。`; } }
  finally { if (current === epoch) { pending = false; update(); } }
}
function start() {
  if (!ready) return; if (recording) finishDemo();
  if (pet.dead) { pet = actor(level.spawn); progress = freshProgress(); }
  if (progress.won) return;
  cancel(); enabled = true; calls = 0; paused = false; $('#soundless-pause').textContent = '暂停'; decide(); canvas.focus();
}
function teach() {
  cancel(); idle(); if (pet.dead) { pet = actor(level.spawn); progress = freshProgress(); }
  human = { ...pet }; recording = { id: crypto.randomUUID(), level, from: { ...human }, actions: [], frames: 0 };
  paused = false; $('#soundless-pause').textContent = '暂停'; $('#camera').value = 'human';
  status = '从精灵当前位置示范，最多 4 秒操作；完成后点击“示范完成”。金币和机关仍只属于精灵。'; update(); canvas.focus();
}
function finishDemo() {
  if (!recording) return;
  if (recording.actions.length && mode === 'lab' && lab.world) {
    const segments = [];
    for (const action of recording.actions) {
      const mask = roleInputToChannels(lab.world, action), last = segments.at(-1);
      if (last && last.a === mask.a && last.b === mask.b && last.c === mask.c && last.frames + action.frames <= 90) last.frames += action.frames;
      else segments.push({ ...mask, frames: action.frames });
    }
    lab.traces = [...lab.traces, runExperiment(lab.world, { id: `human-${Date.now().toString(36)}`, segments, origin: 'human',
      start: recording.from, note: '你亲手做的一次示范' })].slice(-MAX_TRACES);
    logEvent('demo', `你的示范记成一条带标签实验：${recording.frames} 帧，起点 x=${Math.round(recording.from.x)} → 终点 x=${Math.round(human.x)}（${human.dead ? '跌落' : '存活'}），花了 0 次模型调用`);
    saveLab(); status = `已把你的 ${recording.frames} 帧操作记成一次带标签的实验；它还得自己归纳出结论。`;
  } else if (recording.actions.length) {
    const { frames, ...sample } = recording; sample.to = { ...human }; sample.outcome = human.dead ? 'fell' : 'survived';
    samples.push(sample); samples = samples.slice(-8); save(); status = '已记录你的真实操作。下一次模型会参考它；这不代表已经学会。';
  } else status = '这次没有操作，未保存示范。';
  recording = null; update();
}
function scoreLabPrediction() {
  if (mode !== 'lab' || !lab.pending) return;
  const scored = scorePrediction(lab.pending.prediction, lab.pending.start, pet, pet.dead);
  lab.accuracy = { hits: lab.accuracy.hits + scored.hits, total: lab.accuracy.total + scored.total };
  lab.lastScore = scored; lab.pending = null;
  logEvent('predict', `它先预测了这段动作，引擎打分 ${scored.hits}/3${scored.missed.length ? `（错在 ${scored.missed.join('、')}）` : '（全对）'}，累计 ${lab.accuracy.hits}/${lab.accuracy.total}`);
  saveLab();
  status = `${status} · 预测命中 ${scored.hits}/${scored.total}${scored.missed.length ? `（错在 ${scored.missed.join('、')}）` : ''}，累计 ${lab.accuracy.hits}/${lab.accuracy.total}`;
}
// The pet planned this in its own world model; the real engine now grades the plan.
function finishModelPlan() {
  const planned = modelPlan; modelPlan = null;
  if (!planned) return;
  const trace = runExperiment(lab.world, { id: `self-${Date.now().toString(36)}`, segments: planned.actions, origin: 'self', start: planned.start, note: '按它自己的世界模型执行' });
  lab.traces = [...lab.traces, trace].slice(-MAX_TRACES);
  const actual = trace.samples.at(-1);
  const hit = !trace.dead && Math.abs(actual.x - planned.predicted.x) < 40 && Math.abs(actual.y - planned.predicted.y) < 40;
  lab.modelRuns = [...(lab.modelRuns || []), { hit, predicted: planned.predicted, actual: { x: actual.x, y: actual.y }, dead: trace.dead }].slice(-8);
  logEvent('plan', `真引擎执行它模型里的路线：预测落点 x=${planned.predicted.x}，实际 x=${actual.x}${trace.dead ? '（跌落）' : ''} → ${hit ? '模型成立' : '模型不成立'}；这条真实轨迹已进证据表`);
  status = hit
    ? `它的模型说能过，真引擎也过了：预测落点 x=${planned.predicted.x}，实际 x=${actual.x}。这条真实轨迹已进证据表。`
    : `它的模型说能过，真引擎结果不同：${trace.dead ? '跌落了' : `实际 x=${actual.x}，预测 x=${planned.predicted.x}`}。真实轨迹已进证据表，可以让它修模型。`;
  saveLab(); update();
}
function advance() {
  if (paused || !ready || progress.won) return; tick++;
  const input = { move: Number(keys.right) - Number(keys.left), jump: keys.jump };
  if (recording && (recording.frames || input.move || input.jump)) {
    const last = recording.actions.at(-1);
    if (last && last.move === input.move && last.jump === input.jump && last.frames < 90) last.frames++;
    else if (recording.actions.length < 12) recording.actions.push({ ...input, frames: 1 });
    else finishDemo();
    if (recording) recording.frames++;
  }
  step(human, input, level, progress, 'human', physics());
  if (recording && (recording.frames >= 240 || human.dead)) finishDemo();
  if (human.dead) human = actor(level.spawn);
  if (enabled && !pending && !recording) {
    if (queue.length) {
      const action = queue[0]; step(pet, mode === 'lab' && lab.world ? channelInput(lab.world, action) : action, level, progress, 'pet', physics());
      if (--action.frames <= 0) queue.shift();
      if (pet.dead) { falls++; enabled = false; queue = []; status = '精灵跌落了。回去示范，或点击开始从出生点重试。'; }
      if (!queue.length) {
        if (modelPlan) finishModelPlan(); else scoreLabPrediction();
        feedback = `从 ${JSON.stringify(planStart)} 到 ${JSON.stringify(pet)}；${pet.dead ? '跌落' : progress.won ? '完成' : '动作完成'}，物品 ${JSON.stringify(progress)}`;
      }
    } else decide();
  }
  if (progress.won) { enabled = false; status = '小精灵亲自收齐金币、取钥匙、开门并到达终点。'; idle(); }
  if (tick % 6 === 0) update();
}
async function generate() {
  $('#generate').disabled = true; $('#generation-status').textContent = '大模型正在备题，随后验证完整通关路线。你可以继续玩当前关。';
  try {
    const result = await api('/api/jump/generate', { intent: $('#level-intent').value }, AbortSignal.timeout(260000));
    if (result.source !== 'model' || !result.verification?.verified) throw new Error('新关没有验证标记');
    prepared = { ...result, level: validateLevel(result.level) }; $('#use-level').hidden = false;
    $('#generation-status').textContent = `${result.model} 已生成「${prepared.level.title}」，完整物理验证通过。点击进入新关。`;
  } catch (e) { $('#generation-status').textContent = `${e.message}。当前关卡保留。`; }
  finally { $('#generate').disabled = false; }
}
// ---- 空白实验室：先验探针、免费实验台、机制归纳、揭晓真相 ----
const roleName = role => role === 'left' ? '左' : role === 'right' ? '右' : role === 'jump' ? '跳' : '未知';
const labWorldName = () => `世界 ${lab.index}`;
function nextWorld({ first = false } = {}) {
  const carried = lab.notebook.filter(n => n.state === '确认').map(n => ({ ...n, id: `carry-${n.id}`, state: '猜想', evidence: [], confidence: .5 }));
  const stats = first || !lab.world ? lab.stats : [...lab.stats, { index: lab.index, experiments: lab.traces.length,
    confirmed: lab.notebook.filter(n => n.state === '确认').length, accuracy: { ...lab.accuracy }, calls: lab.calls }];
  const seed = Math.floor(Math.random() * 99999) + 1;
  lab = { index: first ? 1 : lab.index + 1, seed, world: labWorld(seed), notebook: carried, traces: [], prior: null, priorScore: null,
    answer: null, pending: null, lastScore: null, accuracy: { hits: 0, total: 0 }, stats: stats.slice(-8), calls: 0, adjusted: [],
    worldModel: null, plan: null, modelRuns: [], log: lab.log || [] };
  mode = 'lab'; cancel(); recording = null; idle();
  level = lab.world.level; human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress();
  calls = falls = 0; feedback = ''; paused = false; $('#soundless-pause').textContent = '暂停';
  $('#level-source').textContent = `空白实验室 · ${labWorldName()} · 机制保密`;
  logEvent('world', `换到${labWorldName()}（种子 ${seed}）：通道含义和物理参数重新隐藏${carried.length ? `；上一个世界确认过的 ${carried.length} 条结论降级为待复核` : '；它对这个世界一无所知'}`);
  status = carried.length ? `换到${labWorldName()}：上一个世界确认过的 ${carried.length} 条结论自动变成待复核，它得在这里重新验证。`
    : `${labWorldName()}：一个小精灵，三个无名通道，它对这个世界一无所知。`;
  $('#lab-enter').hidden = true; $('#back-classic').hidden = false; saveLab(); update();
}
function backToClassic() {
  mode = 'classic'; cancel(); recording = null;
  resetLevel(starterLevel()); $('#level-source').textContent = '内置示范关 · 物理验证通过';
  $('#lab-enter').hidden = false; $('#back-classic').hidden = true; status = '回到示范课：这个世界的物理和目标是明说的。'; update();
}
async function labPrior() {
  if (mode !== 'lab' || pending) return;
  $('#lab-prior').disabled = true;
  try {
    const result = await api('/api/jump/lab/prior', {}, AbortSignal.timeout(60000));
    lab.calls++; lab.prior = result.guesses; lab.priorScore = scorePriorGuesses(result.guesses, lab.world);
    logEvent('prior', `第 ${lab.calls} 次模型调用：不做实验先猜 → ${lab.priorScore.rows.map(r => `${r.channel}=${r.guessed === 'unknown' ? '不知道' : roleName(r.guessed)}(把握${r.confidence})`).join('，')}，命中 ${lab.priorScore.hits}/${lab.priorScore.total}`);
    status = `先验猜测 ${lab.priorScore.hits}/${lab.priorScore.total} 命中：它一次实验都没做，全靠大模型自己的常识。`;
    saveLab(); update();
  } catch (e) { logEvent('error', `先验猜测失败：${e.message}`); status = e.message; update(); }
  finally { $('#lab-prior').disabled = false; }
}
function labBattery() {
  if (mode !== 'lab') return;
  const humanTraces = lab.traces.filter(t => t.origin === 'human');
  lab.traces = [...humanTraces, ...experimentBattery(lab.world)].slice(-MAX_TRACES);
  logEvent('battery', `本地跑了 9 次实验（每个通道短按 6 帧、长按 60 帧、三组两两组合），记录 ${lab.traces.reduce((n, t) => n + t.samples.length, 0)} 帧，花了 0 次模型调用`);
  status = `本地跑完 ${lab.traces.length} 次实验，没有花模型调用：每个通道单独按一下、按住，再两两组合。`;
  saveLab(); update();
}
async function labInduce() {
  if (mode !== 'lab' || pending) return;
  if (!lab.traces.length) { status = '先跑一次实验台，或者亲手示范一次，再让它归纳。'; return update(); }
  $('#lab-induce').disabled = true; pending = true;
  try {
    const result = await api('/api/jump/lab/induce', { world: { name: labWorldName(), level }, traces: lab.traces.slice(-10), notebook: lab.notebook }, AbortSignal.timeout(120000));
    lab.calls++; lab.notebook = summarizeNotebook(result.notebook); lab.adjusted = result.adjusted || []; lab.nextExperiment = result.nextExperiment || null;
    logEvent('induce', `第 ${lab.calls} 次模型调用：读 ${result.experiments} 条实验归纳出手册 → 新增 ${result.learned} 条、确认 ${result.confirmed} 条${lab.adjusted.length ? `、${lab.adjusted.length} 条状态被服务端按证据改写（例：${lab.adjusted[0]}）` : ''}；耗时 ${(result.latencyMs / 1000).toFixed(1)} 秒`);
    for (const note of summarizeNotebook(lab.notebook).slice(-4))
      logEvent('learn', `手册【${note.state}】${note.claim}（证据 ${note.evidence.length} 条）`);
    status = `${result.model} 归纳出 ${result.learned} 条新结论，其中确认 ${result.confirmed} 条${lab.adjusted.length ? `；${lab.adjusted.length} 条状态被按证据改写（${lab.adjusted[0]}）` : ''}。`;
    saveLab();
  } catch (e) { logEvent('error', `归纳失败：${e.message}`); status = e.message; }
  finally { $('#lab-induce').disabled = false; pending = false; update(); }
}
function labReveal() {
  if (mode !== 'lab' || !lab.world) return;
  lab.answer = hiddenTruth(lab.world);
  logEvent('reveal', `揭晓真相：${Object.entries(lab.answer.mapping).map(([channel, role]) => `${channel}=${roleName(role)}`).join(' ')} · 速度 ${lab.answer.physics.speed} · 重力 ${lab.answer.physics.gravity} · 跳跃 ${lab.answer.physics.jump} · 短跳截断 ${lab.answer.physics.cut}`);
  status = '这是这个世界的真相：对照一下它手册里写的，以及你自己按下去时的感觉。';
  update();
}
// 世界模型即代码：模型写一段 step()，服务端真的逐帧跑它，用量出来的误差驱动修复。
async function labWriteModel() {
  if (mode !== 'lab' || pending) return;
  if (!lab.traces.length) { status = '先跑一次实验台或做一次示范，它才有数据可校准。'; return update(); }
  $('#lab-model').disabled = true; pending = true;
  status = '它正在把机制写成可执行代码；服务端会逐帧运行它并和真实记录比对。';
  update();
  try {
    const result = await api('/api/jump/lab/model', { world: { name: labWorldName(), level }, traces: lab.traces.slice(-10), actor: pet, planTo: LAB_PLAN_TARGET }, AbortSignal.timeout(200000));
    lab.calls += Math.max(1, result.attempts || 1);
    lab.worldModel = { code: result.code, verified: result.verified, matched: result.matched, frames: result.frames, error: result.error,
      worst: result.worst, attempts: result.attempts, rounds: result.rounds || [], notes: result.notes, failure: result.failure, mismatches: result.mismatches };
    lab.plan = result.plan && result.plan.length ? { actions: result.plan, predicted: result.predicted, target: result.planTo } : null;
    logEvent('model', `写完世界模型：${result.attempts} 轮修复，共 ${lab.calls} 次模型调用`);
    for (const round of (result.rounds || []).slice(-4))
      logEvent('model', round.problem
        ? `第 ${round.round} 轮：代码没跑起来 —— ${round.problem}`
        : `第 ${round.round} 轮：逐帧比对 ${round.frames} 帧，对上 ${round.matched} 帧（错 ${round.frames - round.matched}，最差 ${round.worst} 倍容差）`);
    logEvent('learn', result.verified
      ? `世界模型通过：能把这个世界逐帧算对（${result.frames} 帧，误差 0）`
      : `世界模型未通过：还有 ${result.frames - result.matched} 帧对不上，所以不拿它规划${result.failure ? `（${result.failure}）` : ''}`);
    if (lab.plan) logEvent('plan', `在它自己的模型里搜出到 x=${result.planTo} 的路线：${lab.plan.actions.length} 段，预测落点 x=${lab.plan.predicted?.x}`);
    if (result.notes) logEvent('learn', `它自己从表里读出的数字：${result.notes}`);
    status = result.verified
      ? `世界模型逐帧跑通 ${result.frames} 帧、误差 0（用了 ${result.attempts} 次尝试）${lab.plan ? `；它还在自己的模型里搜出一条到 x=${result.planTo} 的路线。` : '；不过在模型里没搜到过坑路线。'}`
      : `世界模型还没对上：${result.frames} 帧里错 ${result.frames - result.matched} 帧，最差偏差 ${result.worst} 倍容差（${result.attempts} 次尝试）${result.failure ? `，最后失败原因：${result.failure}` : ''}。`;
    saveLab();
  } catch (e) { logEvent('error', `写世界模型失败：${e.message}`); saveLab(); status = e.message; }
  finally { $('#lab-model').disabled = false; pending = false; update(); }
}
function labRunModelPlan() {
  if (mode !== 'lab' || !lab.plan) { status = '还没有可用规划：先让它写出并通过验证的世界模型。'; return update(); }
  cancel(); idle(); if (pet.dead) { pet = actor(level.spawn); progress = freshProgress(); }
  modelPlan = { actions: lab.plan.actions.map(a => ({ ...a })), predicted: lab.plan.predicted, start: { ...pet } };
  queue = validateChannelActions(modelPlan.actions).map(a => ({ ...a }));
  enabled = true; calls = 0; paused = false; feedback = '';
  logEvent('plan', `开始按模型里的路线真跑：${queue.length} 段，模型预测落点 x=${lab.plan.predicted?.x}`);
  saveLab();
  status = '正在按它自己模型里的路线走；真实引擎会告诉它模型对不对。';
  update();
}
function updateLab() {
  if (!lab.world) {
    $('#lab-world').textContent = '还没开始';
    $('#lab-notebook').textContent = '还没有进入实验室。';
    $('#lab-score').textContent = '点“进入实验室”抽第一个世界。';
    $('#lab-model-out').textContent = '';
    $('#lab-knows').textContent = '还没有进入实验室。';
    $('#lab-log').textContent = '还没有记录。';
    $('#lab-answer').textContent = '';
    return;
  }
  const notes = summarizeNotebook(lab.notebook), confirmed = notes.filter(n => n.state === '确认').length;
  $('#lab-world').textContent = `${labWorldName()} · 种子 ${lab.seed}`;
  $('#lab-notebook').textContent = notes.length
    ? notes.map(n => `【${n.state}】${n.claim}（证据 ${n.evidence.length} 条 · 把握 ${n.confidence}）`).join('　')
    : '还是空的。它对这个世界没有任何结论，连哪个通道会跳都不知道。';
  const accuracy = lab.accuracy.total ? `${Math.round(lab.accuracy.hits / lab.accuracy.total * 100)}%（${lab.accuracy.hits}/${lab.accuracy.total}）` : '还没有下过预测';
  const prior = lab.priorScore ? `${lab.priorScore.hits}/${lab.priorScore.total} 命中 · ${lab.priorScore.rows.map(r => `${r.channel}=${roleName(r.guessed)}`).join(' ')}` : '还没测';
  const history = lab.stats.map(s => `世界 ${s.index}：实验 ${s.experiments} 次 · 确认 ${s.confirmed} 条 · 预测 ${s.accuracy.total ? `${Math.round(s.accuracy.hits / s.accuracy.total * 100)}%` : '—'}`).join('　');
  const runs = lab.modelRuns || [], hits = runs.filter(r => r.hit).length;
  $('#lab-score').textContent = `先验猜测 ${prior}　|　模型调用 ${lab.calls} 次　|　引擎实验 ${lab.traces.filter(t => t.origin === 'engine').length} 次 · 你的示范 ${lab.traces.filter(t => t.origin === 'human').length} 次 · 它自己跑的 ${lab.traces.filter(t => t.origin === 'self').length} 次　|　确认条目 ${confirmed}/${notes.length}　|　预测命中 ${accuracy}${runs.length ? `　|　世界模型规划过坑 ${hits}/${runs.length} 次为真` : ''}${history ? `　|　${history}` : ''}`;
  $('#lab-model-out').textContent = lab.worldModel
    ? `${lab.worldModel.verified ? '✓ 通过' : '✗ 未通过'}：逐帧比对 ${lab.worldModel.frames} 帧，对上 ${lab.worldModel.matched} 帧，最差偏差 ${lab.worldModel.worst} 倍容差，共 ${lab.worldModel.attempts} 次尝试${lab.worldModel.notes ? `　它自己读出的关键数字：${lab.worldModel.notes}` : ''}${lab.plan ? `　|　模型内规划：到 x=${lab.plan.target} 共 ${lab.plan.actions.length} 段，预测落点 x=${lab.plan.predicted?.x}` : ''}\n${lab.worldModel.code}`
    : '还没有世界模型。点“④ 写成可执行世界模型”，它会写一段 step() 代码，服务端逐帧跑它并对答案。';
  $('#lab-answer').textContent = lab.answer
    ? `真相：${Object.entries(lab.answer.mapping).map(([channel, role]) => `${channel}=${roleName(role)}`).join('　')}　·　速度 ${lab.answer.physics.speed} · 重力 ${lab.answer.physics.gravity} · 跳跃力度 ${lab.answer.physics.jump} · 短跳截断 ${lab.answer.physics.cut}`
    : '';
  const knows = summarizeKnowledge({ notebook: lab.notebook, worldModel: lab.worldModel, plan: lab.plan,
    modelRuns: lab.modelRuns || [], accuracy: lab.accuracy, answer: lab.answer });
  const channelLines = knows.channels.map(c => {
    if (!c.known) return `通道 ${c.channel}：还不知道${c.actual ? `（真相是${roleName(c.actual)}）` : ''}`;
    const verdict = c.agrees === null ? '' : c.agrees ? '　✓ 和真相一致' : '　✗ 和真相不符';
    return `通道 ${c.channel}：${c.claims.join('；')}${verdict}`;
  });
  $('#lab-knows').textContent = [
    ...knows.lines,
    ...channelLines,
    `手册统计：确认 ${knows.confirmed} 条 · 待验证 ${knows.pending} 条 · 猜想 ${knows.hypotheses} 条 · 已推翻 ${knows.refuted} 条`,
  ].join('\n');
  const when = at => { const d = new Date(at || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
  $('#lab-log').textContent = (lab.log || []).length
    ? [...lab.log].reverse().map(entry => `[${when(entry.at)}] ${LOG_KINDS[entry.kind] || entry.kind}｜${entry.text}`).join('\n')
    : '还没有记录。按「② 跑实验台」开始，它每一步都会写在这里。';
}
const LOG_KINDS = { world: '世界', prior: '先验', battery: '实验台', demo: '你的示范', induce: '归纳', learn: '学到', model: '世界模型', plan: '规划', act: '行动', predict: '预测', reveal: '揭晓', error: '失败' };
function update() {
  $('#level-title').textContent = level.title;
  $('#objective').textContent = `精灵金币 ${progress.coins.length}/${level.coins.length} · ${progress.key ? '已取钥匙' : '先取钥匙'} · ${progress.switchOn ? '门已开' : '回头开机关'}`;
  $('#pet-status').textContent = paused ? '已暂停。' : status; $('#attempts').textContent = `模型 ${calls}/16 次 · 跌落 ${falls} 次`;
  $('#lesson-count').textContent = `${samples.length} 次示范`; $('#learning-note').textContent = recording ? '正在录制你的真实按键。' : '最近 4 次示范会作为上下文送给模型，未修改模型权重。';
  $('#lessons').textContent = samples.slice(-4).map((s, i) => `${i + 1}. ${s.level.title} · ${s.outcome === 'fell' ? '跌落反例' : '操作示范'}`).join('　');
  $('#finish-demo').hidden = !recording; $('#finish').hidden = !progress.won; $('#retry-pet').disabled = !ready || pending;
  updateLab();
}
function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
function label(text, x, y, color = '#42624e', size = 14) { ctx.fillStyle = color; ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(text, x, y); }
function drawActor(a, isPet) {
  const x = a.x - cameraX, y = a.y;
  if (x < -50 || x > canvas.width + 50) return;
  ctx.save(); ctx.globalAlpha = isPet ? 1 : .78;
  rect(x - 14, Math.min(y, 400) + 1, 28, 4, '#25493725');
  if (isPet) {
    appearance.pixels.forEach((color, i) => { if (color) rect(x - 20 + i % 16 * 2.5, y - 39 + Math.floor(i / 16) * 2.5, 3, 3, color); });
  } else {
    rect(x - 10, y - 27, 20, 23, '#5493ad'); rect(x - 8, y - 37, 17, 16, '#f9ebcd');
    rect(x - 12, y - 40, 23, 7, '#36667d'); rect(x + 1, y - 32, 3, 3, '#2c4650');
    rect(x - 10, y - 6, 7, 6, '#335464'); rect(x + 5, y - 6, 7, 6, '#335464');
  }
  label(isPet ? petName : '你', x, y - (isPet ? 48 : 51), isPet ? '#39683c' : '#396c88', 13); ctx.restore();
}
function draw() {
  const width = Math.max(500, Math.round(canvas.clientWidth)); if (canvas.width !== width) canvas.width = width;
  const target = $('#camera').value === 'pet' ? pet : human;
  cameraX += (Math.max(0, Math.min(Math.max(0, level.width - width + 30), target.x - width * .42)) - cameraX) * .12;
  rect(0, 0, width, 470, '#dceee3');
  for (let i = 0; i < 9; i++) { const x = i * 190 - cameraX * .3; rect(x, 285, 170, 110, '#c5dcbd'); rect(x + 30, 240, 100, 50, '#c5dcbd'); rect(x + 20, 75 + i % 3 * 20, 75, 15, '#f6f9e8'); }
  rect(0, 415, width, 55, '#7dbdb7');
  for (const p of level.platforms) { rect(p.x - cameraX, p.y, p.w, p.y === 400 ? 70 : 20, '#bbad82'); rect(p.x - cameraX, p.y, p.w, 8, '#63915c'); }
  level.coins.forEach((coin, i) => { if (!progress.coins.includes(i)) { rect(coin.x - cameraX - 6, coin.y - 8, 12, 16, '#f4cf62'); rect(coin.x - cameraX - 1, coin.y - 5, 3, 10, '#bd853b'); } });
  if (!progress.key) { label('⚿', level.key.x - cameraX, level.key.y + 5, '#ad752e', 26); label('钥匙', level.key.x - cameraX, level.key.y - 25, '#6c7446', 12); }
  const sx = level.switch.x - cameraX; rect(sx - 14, level.switch.y + 3, 28, 9, progress.switchOn ? '#71ad63' : '#d7a152');
  label(progress.switchOn ? '已开门' : '带钥匙回来', sx, level.switch.y - 20, '#4d6845', 12);
  if (!progress.switchOn) { rect(level.door.x - cameraX - 8, level.door.y, 16, level.door.h, '#8c7966'); label('锁门', level.door.x - cameraX, level.door.y - 12, '#655444', 12); }
  rect(level.goal.x - cameraX - 3, level.goal.y - 70, 6, 70, '#557156'); rect(level.goal.x - cameraX + 3, level.goal.y - 70, 30, 20, '#eccb71');
  label('终点', level.goal.x - cameraX, level.goal.y - 82);
  drawActor(human, false); if (!pet.dead) drawActor(pet, true);
  if (pending) label('模型观察中 · 你可以继续', width / 2, 30, '#3c6450', 15);
  if (paused) { rect(0, 0, width, 470, '#eef4e299'); label('暂停练习', width / 2, 215, '#2f5545', 25); }
}
function frame(time) {
  const elapsed = Math.min((time - previousTime) / 1000 || 0, .1); previousTime = time;
  if (document.hidden) { accumulator = 0; requestAnimationFrame(frame); return; }
  accumulator += elapsed;
  while (accumulator >= 1 / 60) { advance(); accumulator -= 1 / 60; }
  draw(); requestAnimationFrame(frame);
}
const bindings = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'jump', ArrowUp: 'jump', KeyW: 'jump' };
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button,summary') || !bindings[event.code]) return;
  event.preventDefault(); keyboard.add(bindings[event.code]); syncKeys();
});
document.addEventListener('keyup', event => { if (bindings[event.code]) { keyboard.delete(bindings[event.code]); syncKeys(); } });
window.addEventListener('blur', idle); document.addEventListener('visibilitychange', idle);
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); pointers.set(event.pointerId, button.dataset.key); syncKeys(); });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(eventName, event => { pointers.delete(event.pointerId); syncKeys(); });
}
function enterLab() {
  if (!lab.world) return nextWorld({ first: true });
  mode = 'lab'; cancel(); recording = null; idle();
  level = lab.world.level; human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress();
  calls = falls = 0; feedback = ''; paused = false; lab.pending = null; $('#soundless-pause').textContent = '暂停';
  $('#level-source').textContent = `空白实验室 · ${labWorldName()} · 机制保密`;
  logEvent('world', `回到${labWorldName()}：手册 ${summarizeNotebook(lab.notebook).length} 条、实验 ${lab.traces.length} 次、累计模型调用 ${lab.calls} 次`);
  status = '回到这个世界的实验室：机制手册和实验记录都还在。';
  saveLab(); $('#lab-enter').hidden = true; $('#back-classic').hidden = false; update(); canvas.focus();
}
$('#lab-enter').addEventListener('click', enterLab);
$('#back-classic').addEventListener('click', backToClassic);
$('#lab-prior').addEventListener('click', labPrior);
$('#lab-battery').addEventListener('click', labBattery);
$('#lab-induce').addEventListener('click', labInduce);
$('#lab-try').addEventListener('click', start);
$('#lab-reveal').addEventListener('click', labReveal);
$('#lab-model').addEventListener('click', labWriteModel);
$('#lab-run-model').addEventListener('click', labRunModelPlan);
$('#lab-next').addEventListener('click', () => nextWorld());
$('#lab-forget').addEventListener('click', () => { cancel(); lab = { ...lab, notebook: [], traces: [], prior: null, priorScore: null, answer: null, accuracy: { hits: 0, total: 0 }, stats: [], calls: 0, adjusted: [], worldModel: null, plan: null, modelRuns: [], log: [] }; saveLab(); status = '这只精灵的机制手册、实验记录、世界模型和学习日志已清空，世界没有换。'; update(); });
$('#teach').addEventListener('click', teach);
$('#finish-demo').addEventListener('click', () => { finishDemo(); start(); });
$('#retry-pet').addEventListener('click', start);
$('#restart').addEventListener('click', () => { resetLevel(); canvas.focus(); });
$('#soundless-pause').addEventListener('click', () => { paused = !paused; idle(); $('#soundless-pause').textContent = paused ? '继续' : '暂停'; update(); canvas.focus(); });
$('#generate').addEventListener('click', generate);
$('#use-level').addEventListener('click', () => { if (prepared) { resetLevel(prepared.level); $('#level-source').textContent = `大模型生成 · ${prepared.model} · 物理验证通过`; prepared = null; $('#use-level').hidden = true; } });
$('#next-level').addEventListener('click', () => { resetLevel(); $('#level-intent').focus(); });
$('#forget').addEventListener('click', () => { cancel(); samples = []; recording = null; save(); status = '本浏览器中这只精灵的跳跃示范已清空。'; update(); });
init(); requestAnimationFrame(frame);
