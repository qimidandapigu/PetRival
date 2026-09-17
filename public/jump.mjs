import { actor, step, progress as freshProgress, worldProgress, latchPlates, replayActions, validateLevel, validateActions, attributeAttempt, PHYSICS } from './jump-world.mjs';
import { labWorld, experimentBattery, runExperiment, roleInputToChannels, channelInput, summarizeNotebook, scorePrediction, scoreLessonPrediction, sameSpotStreak, stallStreak, scorePriorGuesses, hiddenTruth, validateChannelActions, MAX_TRACES, LAB_PLAN_TARGET, MAX_LOG, logLine, summarizeKnowledge } from './jump-lab.mjs';
import { STAGES, stageLevel, stageInfo, nextStage, unlockAfter, stagePickerState } from './jump-stages.mjs';
import { defaultAppearance, validateAppearance, petDisplayName } from '/shared/pet.mjs';
const $ = s => document.querySelector(s), canvas = $('#jump-canvas'), ctx = canvas.getContext('2d');
let stageId = 1, clearedStages = [], stageKey = 'petrival.jump.stage.v1';
let level = stageLevel(stageId), human = actor(level.spawn), pet = actor(level.spawn), progress = freshProgress(), humanProgress = freshProgress();
// Co-op levels (level.coop): coins/key/door-latch live in one shared object; each side's own
// progress only carries its `won` flag plus a synced display copy of the shared state.
let coopShared = level.coop ? worldProgress() : null;
function resetCoop() { coopShared = level.coop ? worldProgress() : null; }
function syncShared() {
  if (!coopShared) return;
  for (const side of [progress, humanProgress]) { side.coins = [...coopShared.coins]; side.key = coopShared.key; side.switchOn = coopShared.switchOn; }
}
let appearance = defaultAppearance('xiaotangyuan'), petName = '小精灵', storageKey = 'petrival.jump.v2.guest';
let samples = [], recording = null, enabled = false, pending = false, paused = false, ready = false, epoch = 0, abort;
let queue = [], calls = 0, falls = 0, humanFalls = 0, tick = 0, cameraX = 0, previousTime = 0, accumulator = 0;
let status = '第 1 关只要一直往右走。点开始让小精灵自己试，或你亲自走一遍给它看。', feedback = '', planStart, prepared = null, petRespawnAt = 0, humanWon = false, petWonLogged = false;
let lastGoal = '', petWins = 0, humanWins = 0, logFilter = 'all', sidebars = true;
// The pet's own experience, and the rules it has summarised out of that experience and your
// demonstrations. Both are memory: they are stored and re-sent, the weights never change.
let attempts = [], lessonNotes = [], planActions = [];
// Two-tier memory: the handbook holds rules marked 通用 (physics and mechanics that are true
// in EVERY level — the jump-distance table, how the switch/door chain works) and persists
// across stages; lessonNotes stay per-stage map facts. Reflections write both books.
let generalNotes = [], handbookKey = 'petrival.jump.handbook.v1';
function saveHandbook() { try { localStorage.setItem(handbookKey, JSON.stringify(generalNotes)); } catch {} }
function allKnowledge() { return [...generalNotes, ...lessonNotes]; }
// Reflexion loop state (classic lesson mode): the pet predicts where each plan ends, the
// engine grades it, and repeated falls in the same spot trigger an automatic review.
let lessonPredictionPending = null, lessonAccuracy = { hits: 0, total: 0 }, autoReflects = 0, reflecting = false;
// Playback never waits for thinking: while the current segment plays, the engine simulates
// its exact end state (deterministic physics) and the next segment is requested ahead of
// time. `prefetched` holds that ready-made next plan.
let prefetched = null;
function saveStage() { try { localStorage.setItem(stageKey, JSON.stringify({ stageId, cleared: clearedStages, petWins, humanWins, attempts: attempts.slice(-8), notes: lessonNotes })); } catch {} }function loadStage(stored) {
  if (!stored) return;
  try {
    stageId = Math.min(STAGES.length, Math.max(1, Math.trunc(Number(stored.stageId)) || 1));
    clearedStages = unlockAfter(Array.isArray(stored.cleared) ? stored.cleared : [], 0).filter(id => id <= STAGES.length);
    petWins = Number.isInteger(stored.petWins) ? stored.petWins : 0;
    humanWins = Number.isInteger(stored.humanWins) ? stored.humanWins : 0;
    attempts = Array.isArray(stored.attempts) ? stored.attempts.slice(-8) : [];
    lessonNotes = summarizeNotebook(stored.notes);
    level = stageLevel(stageId);
  } catch { stageId = 1; clearedStages = []; attempts = []; lessonNotes = []; }
}
// One line of experience: where it started, what it pressed, where it ended and whether it
// died. This is what makes "I fell in the same place three times" visible to the model.
// Decision context only carries demonstrations that have NOT yet been distilled into rules —
// once a reflection has consumed a recording, the rules speak for it and the raw clip would
// just be tokens. Reflections still see all samples.
function freshSamples() { return samples.filter(s => !s.distilled).slice(-4); }
// Causal events of the CURRENT attempt: pickups, the switch, the door — the data a reflection
// needs to learn "key → step on switch → door opens" instead of misreading a closed door as a
// jump problem. Reset when a plan is adopted; attached to the attempt when it ends.
let attemptEvents = [];
// Anchors, measured by the engine frame by frame — never guessed by the model: where the pet
// was last grounded (the real take-off spot) and where it fell. Reflections and the engine
// experiment anchor on THESE, which is what keeps learned rules grounded in fact.
let attemptTakeOff = null, attemptFellAt = null, attemptFlags = new Set();
function pushAttemptEvent(id, msg) { if (attemptFlags.has(id)) return; attemptFlags.add(id); attemptEvents.push(msg); }
function noteAttemptEvents(before) {
  const at = o => `@x=${Math.round(o.x)}`;
  if (!before.key && progress.key) attemptEvents.push(`取得钥匙${at(level.key)}`);
  if (!before.switchOn && progress.switchOn) attemptEvents.push(`踩下机关${at(level.switch)}（门开了）`);
  for (const i of progress.coins) if (!before.coins.includes(i)) attemptEvents.push(`捡到金币${at(level.coins[i])}`);
  // Near-misses are attributed by ONE generic engine rule (entered the region / passed by,
  // but the effect did not fire, and which preconditions are missing) — not per-object code.
  for (const ev of attributeAttempt(pet, level, coopShared || progress, progress, { prevX: before.x, move: queue[0]?.move || 0 })) pushAttemptEvent(ev.id, ev.msg);
}
function recordAttempt() {
  if (!planActions.length) return;
  const outcome = pet.dead ? 'fell' : progress.won ? 'won' : 'alive';
  attempts = [...attempts, { from: { x: planStart.x, y: planStart.y, vy: planStart.vy, grounded: planStart.grounded },
    to: { x: pet.x, y: pet.y, vy: pet.vy, grounded: pet.grounded }, outcome, actions: planActions.map(a => ({ ...a })),
    ...(attemptTakeOff ? { takeOff: { x: Math.round(attemptTakeOff.x), y: Math.round(attemptTakeOff.y) } } : {}),
    ...(attemptFellAt != null ? { fellAt: attemptFellAt } : {}),
    ...(attemptEvents.length ? { events: [...attemptEvents] } : {}) }].slice(-8);
  planActions = []; attemptEvents = []; attemptTakeOff = null; attemptFellAt = null; attemptFlags = new Set();
  logEvent('attempt', `第 ${attempts.length} 次尝试：x=${Math.round(planStart.x)} → x=${Math.round(pet.x)}（${outcome === 'fell' ? '掉下去了' : outcome === 'won' ? '通关' : '还活着'}）${attempts[attempts.length - 1].events ? `，事件：${attempts[attempts.length - 1].events.join('；')}` : ''}，动作 ${describeActions(attempts[attempts.length - 1].actions, false)}`);
}
// Demonstrations and failed attempts become rules, not just replayable clips.
async function learnLesson(trigger = '') {
  // Reflection runs on the server's induce lane, in parallel with decisions (play lane) and
  // prefetch — it must NOT be dropped just because a decision is in flight. Its own flag
  // only prevents two reflections overlapping each other.
  if (mode === 'lab' || reflecting) return;
  if (!attempts.length && !samples.length) { status = '还没有可以总结的东西：让它试几次，或者你示范一次。'; return update(); }
  reflecting = true;
  $('#lesson-learn').disabled = true;
  status = trigger ? '它正在复盘刚才的失败…' : '正在把你的示范和它的尝试总结成这一关的规则…'; update();
  try {
    const result = await api('/api/jump/lesson/learn', { level, attempts, demonstrations: samples.slice(-4), knowledge: allKnowledge(), trigger, progress }, AbortSignal.timeout(120000));
    // Split the reduced notebook back into the two books by scope: 通用 rules go to the
    // cross-stage handbook, everything else stays with this stage.
    const reduced = summarizeNotebook(result.knowledge);
    generalNotes = reduced.filter(n => n.scope === '通用'); lessonNotes = reduced.filter(n => n.scope !== '通用');
    saveHandbook(); saveStage();
    // Distillation: every demonstration the reflection just saw has been turned into rules,
    // so decision calls stop shipping the raw recording and rely on the rules instead. The
    // sample itself stays in 示范记忆 for the next reflection and for the UI.
    for (const s of samples) s.distilled = true; save();
    // New rules must change what it does next: a death-prefetched plan was computed with the
    // OLD understanding, so discard it and let the respawned pet decide with the new rules.
    if (prefetched?.afterDeath && (result.learned > 0 || result.confirmed > 0 || result.adjusted.length)) {
      prefetched = null;
      logEvent('learn', '复盘得出了新规则，按旧认识预取的复活段已丢弃，复活后会用新规则重新决策');
    }
    logEvent('learn', `总结完成：新增 ${result.learned} 条规则、确认 ${result.confirmed} 条${result.adjusted.length ? `、${result.adjusted.length} 条被按证据降级` : ''}`);
    for (const note of reduced.slice(-3)) logEvent('learn', `规则【${note.state}·${note.scope}】${note.claim}（证据 ${note.evidence.length} 条）`);
    if (Array.isArray(result.experiment)) logEvent('learn', `引擎实验（从上次起跳点向右跳）：${result.experiment.filter(r => !r.error).map(r => `按住 ${r.holdFrames} 帧→${r.dead ? '摔死' : `跳出 ${r.traveled}px`}`).join('；')}`);
    // The reflection must change what it does next, not only what it knows: a proposed
    // never-tried variant becomes the very next plan.
    if (trigger && Array.isArray(result.tryActions) && result.tryActions.length && enabled && !pet.dead && !progress.won) {
      try {
        queue = validateActions(result.tryActions).map(a => ({ ...a }));
        planActions = queue.map(a => ({ ...a })); lessonPredictionPending = null;
        logEvent('plan', `它要试一个从未试过的做法：${describeActions(queue, false)}`);
      } catch { /* an unusable variant just falls back to a fresh decision */ }
    }
    status = `现在有 ${generalNotes.length} 条通用规则 + ${lessonNotes.length} 条本关规则（其中确认 ${reduced.filter(n => n.state === '确认').length} 条），它下次决策会参考。`;
  } catch (e) { logEvent('error', `总结失败：${e.message}`); status = e.message; }
  finally { reflecting = false; $('#lesson-learn').disabled = false; update(); }
}
// Reflexion: nobody clicks anything. Two falls in the same spot — or two attempts that fail
// to push the frontier forward at all — make it stop and turn its failures into rules.
function maybeAutoReflect() {
  if (mode === 'lab' || reflecting || autoReflects >= 3) return;
  const { streak, x } = sameSpotStreak(attempts), stall = stallStreak(attempts);
  if (streak < 2 && stall.streak < 2) return;
  autoReflects++;
  const reason = streak >= 2
    ? `在 x≈${Math.round(x)} 附近连续摔了 ${streak} 次，同一做法反复失败`
    : `连续 ${stall.streak} 次尝试都没能把最远距离推进过 x≈${Math.round(stall.best ?? 0)}，一直卡在原地`;
  logEvent('learn', streak >= 2 ? `同一区域（x≈${Math.round(x)}）连续跌落 ${streak} 次，自动让它复盘` : `连续 ${stall.streak} 次尝试没有实质进展（卡在 x≈${Math.round(stall.best ?? 0)}），自动让它复盘`);
  learnLesson(reason);
}
function scoreLessonPending() {
  const pending0 = lessonPredictionPending;
  lessonPredictionPending = null;
  if (!pending0) return;
  const scored = scoreLessonPrediction(pending0.prediction, pet, pet.dead);
  if (!scored) return;
  lessonAccuracy = { hits: lessonAccuracy.hits + scored.hits, total: lessonAccuracy.total + scored.total };
  const p = pending0.prediction;
  logEvent('predict', `它预测落点 x∈[${p.xMin},${p.xMax}]${p.dead ? '（会摔）' : ''}，实际 x=${scored.actual.x}${scored.actual.dead ? '（跌落）' : ''} → ${scored.hit ? '预测命中' : `预测落空（错在 ${scored.missed.join('、')}）`}，累计 ${lessonAccuracy.hits}/${lessonAccuracy.total}`);
  feedback += scored.hit ? '；预测命中' : `；预测落空（${scored.missed.join('、')}）`;
}
// Blank lab: this world's channel roles and physics exist only in `lab.world`, and `mode`
// decides whether the model is playing a designed level or learning from scratch.
let mode = 'classic', labStorageKey = 'petrival.jump.lab.v1.guest';
let lab = { index: 1, seed: 0, world: null, notebook: [], traces: [], prior: null, priorScore: null, answer: null,
  pending: null, lastScore: null, accuracy: { hits: 0, total: 0 }, stats: [], calls: 0, adjusted: [], worldModel: null, plan: null, modelRuns: [], log: [] };
let modelPlan = null;
// Split view keeps one camera per pane over the same world, so the pet and you stay visible
// at once. Rounds exist so demonstrating repeatedly does not wipe what the pet has learned.
let splitView = true, cameraPet = 0, cameraHuman = 0, roundIndex = 1, roundDemos = 0;
const viewKey = 'petrival.jump.split.v1';
function saveView() { try { localStorage.setItem(viewKey, JSON.stringify({ splitView })); } catch {} }
// The log is the only place the player can see what actually happened, so every step writes
// a line here: free engine work, paid model calls, what changed, and what it cost.
// Every event also ships to the local server (data/client-log.jsonl) so a session can be
// analysed afterwards — the on-screen log is for playing, the file is for debugging.
let logOutbox = [], logTimer = 0;
function flushLogs() {
  if (typeof clearTimeout === 'function') clearTimeout(logTimer);
  logTimer = 0;
  const entries = logOutbox.splice(0, 20);
  if (!entries.length) return;
  api('/api/log/client', { page: 'jump', entries }).catch(() => { logOutbox.unshift(...entries.slice(-10)); });
}
function shipLog(kind, text) {
  logOutbox.push({ at: Date.now(), kind, text: String(text).slice(0, 500) });
  if (logOutbox.length >= 10 || ['fall', 'win', 'learn', 'error'].includes(kind) || typeof setTimeout !== 'function') flushLogs();
  else if (!logTimer) logTimer = setTimeout(flushLogs, 3000);
}
function logEvent(kind, text) {
  lab.log = [...(lab.log || []), logLine(kind, text)].slice(-MAX_LOG);
  shipLog(kind, text);
  // Persist on the event itself: a fall, a demonstration or a decision must survive a
  // reload even when nothing else in the lab changed.
  saveLab();
}
// What the pet can see right now, in the terms the decision is actually about: where it
// stands, how far the ground runs, and what the last attempt ended as.
function describeSituation() {
  const under = level.platforms.find(p => pet.x >= p.x && pet.x <= p.x + p.w && Math.abs(p.y - pet.y) < 1);
  const ahead = level.platforms.filter(p => p.x > pet.x).sort((a, b) => a.x - b.x)[0];
  const parts = [`x=${Math.round(pet.x)} y=${Math.round(pet.y)} ${pet.grounded ? '落地' : `空中 vy=${pet.vy.toFixed(1)}`}`];
  if (under) {
    const edge = under.x + under.w - pet.x;
    parts.push(ahead && ahead.y >= under.y ? `前方 ${Math.max(0, Math.round(edge))} 像素后是空隙` : `脚下平台还剩 ${Math.max(0, Math.round(edge))} 像素`);
  } else parts.push('脚下没有平台');
  parts.push(`金币 ${progress.coins.length}/${level.coins.length}`, progress.key ? '已取钥匙' : '未取钥匙', progress.switchOn ? '机关已开' : '机关未开');
  return parts.join(' · ');
}
function describeActions(actions, learning) {
  const channel = { a: 'A', b: 'B', c: 'C' };
  return actions.map(a => {
    if (learning) {
      const on = ['a', 'b', 'c'].filter(k => a[k]).map(k => channel[k]);
      return on.length ? `按住 ${on.join('+')} ${a.frames} 帧` : `松手 ${a.frames} 帧`;
    }
    const move = a.move === 1 ? '向右' : a.move === -1 ? '向左' : '不动';
    return `${move}${a.jump ? ' + 跳' : ''} ${a.frames} 帧`;
  }).join('，');
}
function describePrediction(p) {
  return `${p.dy === 'up' ? '会升高' : p.dy === 'down' ? '会下落' : '高度不变'} / ${p.grounded ? '会落地' : '不会落地'} / ${p.dead ? '会摔死' : '不会摔死'}`;
}
// Memory is the only thing that changes between calls; the weights never do. Keeping the
// previous snapshot lets the page show exactly what each call added, changed or dropped.
function snapshotMemory(learning) {
  if (learning) return summarizeNotebook(lab.notebook).map(n => ({ id: n.id, text: `${n.claim}（${n.state} · 证据 ${n.evidence.length} 条）` }));
  return samples.map((s, i) => ({ id: s.id || `sample-${i}`,
    text: `${s.level.title} · x=${Math.round(s.from.x)}→${Math.round(s.to.x)} ${s.outcome === 'fell' ? '摔了' : '成功'} ${s.actions.reduce((n, a) => n + a.frames, 0)} 帧` }));
}
function noteMemory(label, learning) {
  const now = snapshotMemory(learning), before = Array.isArray(lab.memory) ? lab.memory : [];
  const beforeIds = new Set(before.map(e => e.id)), nowIds = new Set(now.map(e => e.id));
  const added = now.filter(e => !beforeIds.has(e.id)).map(e => e.text);
  const changed = now.filter(e => { const old = before.find(b => b.id === e.id); return old && old.text !== e.text; })
    .map(e => `${before.find(b => b.id === e.id).text} → ${e.text}`);
  const dropped = before.filter(e => !nowIds.has(e.id)).map(e => e.text);
  lab.memory = now;
  lab.memoryLog = [...(lab.memoryLog || []), { at: Date.now(), label, added, changed, dropped, count: now.length }].slice(-8);
}
function memoryChangeLines() {
  const entries = lab.memoryLog || [];
  if (!entries.length) return ['· 还没有发生任何记忆变化。'];
  return entries.slice(-3).reverse().map(entry => {
    const bits = [];
    if (entry.added.length) bits.push(`新增 ${entry.added.length} 条`);
    if (entry.changed.length) bits.push(`改写 ${entry.changed.length} 条`);
    if (entry.dropped.length) bits.push(`挤掉 ${entry.dropped.length} 条`);
    return `· ${entry.label}：${bits.length ? bits.join(' · ') : '没有变化'}（现在 ${entry.count} 条）`;
  });
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
  stageKey = storageKey.replace('jump.v2', 'jump.stage.v1');
  handbookKey = storageKey.replace('jump.v2', 'jump.handbook.v1');
  try { generalNotes = summarizeNotebook(JSON.parse(localStorage.getItem(handbookKey) || '[]')); } catch { generalNotes = []; }
  try { loadStage(JSON.parse(localStorage.getItem(stageKey) || 'null')); } catch {}
  try { const stored = JSON.parse(localStorage.getItem(storageKey) || '[]'); samples = (Array.isArray(stored) ? stored : []).slice(-8).filter(d => { try { validateLevel(d.level); validateActions(d.actions); return d.from && d.to; } catch { return false; } }); } catch {}
  try { loadLab(JSON.parse(localStorage.getItem(labStorageKey) || 'null')); } catch {}
  try { const view = JSON.parse(localStorage.getItem(viewKey) || 'null');
    if (view) splitView = view.splitView !== false; } catch {}
  $('#split').checked = splitView;
  human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); humanProgress = freshProgress(); resetCoop();
  ready = true; update();
}
// One stage at a time, in order: the ladder starts at "walk right" so a pet that knows
// nothing can still finish something on the first try.
function goToStage(id, reason = '') {
  const target = Math.max(1, Math.min(STAGES.length, Math.trunc(Number(id)) || 1));
  if (target !== 1 && !clearedStages.includes(target) && !clearedStages.includes(target - 1))
    return status = `第 ${target} 关还没解锁：先过第 ${target - 1} 关。`;
  cancel(); idle(); recording = null; stageId = target; level = stageLevel(target);
  human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); humanProgress = freshProgress(); resetCoop();
  lab.memory = null; lab.memoryLog = [];
  calls = falls = humanFalls = 0; feedback = ''; paused = false; roundIndex = 1; roundDemos = 0; petRespawnAt = 0; humanWon = false; petWonLogged = false; lastGoal = '';
  const info = stageInfo(target);
  $('#level-source').textContent = `课程第 ${target} 关 · 物理验证通过`;
  status = `第 ${target} 关「${info.name}」${reason}：${info.skill}提示：${info.hint}`;
  logEvent('world', `进入第 ${target} 关「${info.name}」${reason}：${info.skill}`);
  saveStage(); update(); canvas.focus();
}
function markCleared(id, who) {
  if (clearedStages.includes(id)) return;
  clearedStages = unlockAfter(clearedStages, id); saveStage();
  const next = nextStage(id);
  logEvent('win', `${who}通关第 ${id} 关「${stageInfo(id).name}」${next ? `，解锁第 ${next} 关「${stageInfo(next).name}」` : '，六关全部通过'}`);
  update();
}
function cancel() { epoch++; abort?.abort(); pending = false; enabled = false; queue = []; prefetched = null; }
// A round reset moves both of you back to the spawn and clears the objective, and keeps
// every trace, notebook entry and world model: that is what makes repeated demonstrating
// useful instead of starting the learning over.
function restartRound(reason = '') {
  if (recording) finishDemo();
  cancel(); idle(); recording = null;
  human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); humanProgress = freshProgress(); resetCoop();
  calls = falls = humanFalls = 0; feedback = ''; paused = false; petRespawnAt = 0; humanWon = false; petWonLogged = false; roundIndex++; roundDemos = 0;
  autoReflects = 0; lessonPredictionPending = null;
  $('#soundless-pause').textContent = '暂停'; $('#camera').value = 'human';
  status = `第 ${roundIndex} 轮${reason}：位置和目标重置，${mode === 'lab' ? '机制手册、实验记录和世界模型都保留' : '你的示范笔记保留'}。可以「回去示范」。`;
  logEvent('round', `第 ${roundIndex} 轮重开${reason}：${mode === 'lab' ? `手册 ${summarizeNotebook(lab.notebook).length} 条、实验 ${lab.traces.length} 次、累计模型调用 ${lab.calls} 次全部保留` : `已存 ${samples.length} 次示范`}`);
  if (mode === 'lab') saveLab();
  update(); canvas.focus();
}
function resetLevel(next = level) {
  cancel(); idle(); recording = null; level = validateLevel(next); human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); humanProgress = freshProgress(); resetCoop();
  calls = falls = humanFalls = 0; feedback = ''; paused = false; roundIndex = 1; roundDemos = 0; petRespawnAt = 0; humanWon = false; petWonLogged = false;
  autoReflects = 0; lessonPredictionPending = null;
  $('#soundless-pause').textContent = '暂停'; status = '关卡已锁定。点击开始，让模型自己尝试。'; update();
}
// Adopting a plan is the same whether it was just decided live or prefetched during playback:
// the queue starts HERE, so planStart and the prediction baseline are taken at adoption time.
function adoptPlan(result, learning) {
  planStart = { ...pet };
  queue = (learning ? validateChannelActions(result.actions) : validateActions(result.actions, 360)).map(a => ({ ...a }));
  planActions = learning ? [] : queue.map(a => ({ ...a }));
  attemptEvents = []; attemptTakeOff = null; attemptFellAt = null; attemptFlags = new Set();
  if (result.plan) logEvent('plan', `它打算这么过这一关：${result.plan}`);
  const injected = learning
      ? { lines: [`手册 ${result.notesProvided} 条（未确认 ${result.unconfirmed}）`], bytes: 0 }
      : { lines: [`未蒸馏示范 ${freshSamples().length} 条（共 ${samples.length} 条）`, `备注 ${$('#teacher-note').value ? '1 句' : '无'}`, `上次结果 ${feedback ? '1 条' : '无'}`], bytes: 0 };
    // The log's job here is the decision itself: what it was shown, what it picked, what it
    // expects — not the plumbing around the call.
    logEvent('choice', `第 ${calls} 次选择：看到 ${describeSituation()}${feedback ? ` · 上次「${feedback.slice(0, 24)}…」` : ''} ｜ 记忆：${injected.lines.join(' + ')} ｜ 它选择：${describeActions(queue, learning)} ｜ 目标「${result.goal || (learning ? '试探这个世界' : '继续前进')}」${result.prediction ? ` ｜ 预测：${learning ? describePrediction(result.prediction) : `落点 x∈[${result.prediction.xMin},${result.prediction.xMax}]${result.prediction.dead ? '（它预计会摔）' : ''}`}` : ''} ｜ ${(result.latencyMs / 1000).toFixed(1)} 秒`);
    if (learning) lab.calls++;
    if (learning) lab.pending = result.prediction ? { prediction: result.prediction, start: { ...pet } } : null;
    else lessonPredictionPending = result.prediction ? { prediction: result.prediction, start: { ...pet } } : null;
    noteMemory(`第 ${calls} 次选择`, learning);
    saveLab(); update();
    status = learning
      ? `${result.model}：${result.goal || '试探这个世界'} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 手册 ${result.notesProvided} 条（未确认 ${result.unconfirmed}）· ${result.prediction ? '已先下预测' : '这次没给预测'}`
      : `${result.model}：${result.goal || '执行下一段动作'} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 参考 ${result.usedDemonstrations.length}/${result.demonstrationsProvided} 次示范`;
    lastGoal = result.goal || '';
}
async function decide() {
  if (!enabled || pending || paused || recording || progress.won || pet.dead) return;
  if (calls >= 16) { enabled = false; status = '本轮已调用 16 次模型，暂停节省额度。可以示范后再继续。'; update(); return; }
  const learning = mode === 'lab';
  pending = true; calls++; const current = epoch; abort = new AbortController();
  status = learning ? '模型正在看这个世界的实验记录和它的机制手册；你可以继续移动。' : '模型正在观察关卡和你的示范；你可以继续移动。'; update();
  try {
    const result = await api(learning ? '/api/jump/lab/plan' : '/api/jump/decision',
      learning ? { world: { name: `世界 ${lab.index}`, level }, actor: pet, progress, notebook: lab.notebook, note: $('#teacher-note').value, feedback }
        : { level, actor: pet, progress, demonstrations: freshSamples(), attempts, knowledge: allKnowledge(), note: $('#teacher-note').value, partner: partnerView() },
      AbortSignal.any([abort.signal, AbortSignal.timeout(100000)]));
    if (current !== epoch) return;
    if (result.method !== 'model') throw new Error('接口未返回真实模型动作，已暂停');
    adoptPlan(result, learning);
  } catch (e) { if (current === epoch) { enabled = false; logEvent('error', `决策失败：${e.name === 'TimeoutError' ? '模型等待超时' : e.message}`); saveLab(); status = `${e.name === 'TimeoutError' ? '模型等待超时' : e.message}；真人可继续，点击开始重试。`; } }
  finally { if (current === epoch) { pending = false; update(); } }
}
// The engine is deterministic, so the end of the current queue can be computed exactly and
// the next plan requested while this one is still playing. If reality diverges (a fall), the
// prefetched plan is discarded — see advance().
function simulateQueueEnd() {
  if (!queue.length) return null;
  const sim = replayActions(level, actor({ x: pet.x, y: pet.y, vy: pet.vy, grounded: pet.grounded, held: pet.held }),
    { coins: [...progress.coins], key: progress.key, switchOn: progress.switchOn, won: progress.won }, queue.map(a => ({ ...a })),
    'pet', physics(), coopShared, human);
  return { pet: sim.actor, progress: sim.progress };
}
// What the model needs to know about the other player in a co-op level.
function partnerView() { return coopShared ? { x: Math.round(human.x), y: Math.round(human.y), dead: human.dead, won: humanProgress.won } : undefined; }
async function prefetch() {
  if (mode === 'lab' || !enabled || pending || paused || recording || progress.won || pet.dead || prefetched || !queue.length) return;
  if (calls >= 16) return;
  const sim = simulateQueueEnd();
  if (!sim || sim.progress.won) return;
  // The engine already knows how this segment ends — including a fall. A fall is no reason
  // to stop thinking: the respawn state is fully determined (spawn + fresh progress), so the
  // next plan can be computed from THERE and adopted the moment the pet comes back.
  const afterDeath = sim.pet.dead;
  const fromActor = afterDeath ? actor(level.spawn) : sim.pet;
  const fromProgress = afterDeath
    ? (coopShared ? { coins: [...coopShared.coins], key: coopShared.key, switchOn: coopShared.switchOn, won: false } : freshProgress())
    : sim.progress;
  pending = true; calls++; const current = epoch; abort = new AbortController();
  try {
    const result = await api('/api/jump/decision',
      { level, actor: fromActor, progress: fromProgress, demonstrations: freshSamples(), attempts, knowledge: allKnowledge(), note: $('#teacher-note').value, partner: partnerView() },
      AbortSignal.any([abort.signal, AbortSignal.timeout(100000)]));
    if (current !== epoch) return;
    if (result.method !== 'model') throw new Error('接口未返回真实模型动作');
    prefetched = { result, afterDeath };
    logEvent('plan', afterDeath
      ? `推演出这段会摔，已提前从复活点算好下一段（${describeActions(result.actions, false)} · ${(result.latencyMs / 1000).toFixed(1)} 秒），复活即接上`
      : `后台已提前推演出下一段（${describeActions(result.actions, false)} · ${(result.latencyMs / 1000).toFixed(1)} 秒），当前段播完即接上`);
  } catch (e) { if (current === epoch) logEvent('error', `预取失败（不影响当前播放，播完会现场决定）：${e.name === 'TimeoutError' ? '模型等待超时' : e.message}`); }
  finally { if (current === epoch) pending = false; }
}
function start() {
  if (!ready) return; if (recording) finishDemo();
  if (pet.dead) { pet = actor(level.spawn); progress = freshProgress(); petRespawnAt = 0; }
  if (progress.won) return;
  cancel(); enabled = true; calls = 0; paused = false; $('#soundless-pause').textContent = '暂停';
  logEvent('act', mode === 'lab' ? `让它按手册自己闯（本轮最多 16 次模型调用）` : `让它自己闯（本轮最多 16 次模型调用，参考最近 ${samples.length} 次示范）`);
  saveLab(); decide(); canvas.focus();
}
function teach() {
  cancel(); idle(); if (pet.dead) { pet = actor(level.spawn); progress = freshProgress(); petRespawnAt = 0; }
  human = { ...pet }; recording = { id: crypto.randomUUID(), level, from: { ...human }, actions: [], frames: 0 };
  paused = false; $('#soundless-pause').textContent = '暂停'; $('#camera').value = 'human';
  status = mode === 'lab' ? '从精灵当前位置示范，最多 4 秒操作；完成后点击“示范完成”。你的金币和机关算你自己的。'
    : '从精灵当前位置示范，最多 4 秒操作；完成后点击“示范完成”，它就会参考。';
  logEvent('demo', '开始录制你的示范（最多 4 秒 / 240 帧）');
  update(); canvas.focus();
}
function finishDemo() {
  if (!recording) return;
  if (recording.actions.length) roundDemos++;
  if (recording.actions.length && mode === 'lab' && lab.world) {
    const segments = [];
    for (const action of recording.actions) {
      const mask = roleInputToChannels(lab.world, action), last = segments.at(-1);
      if (last && last.a === mask.a && last.b === mask.b && last.c === mask.c && last.frames + action.frames <= 90) last.frames += action.frames;
      else segments.push({ ...mask, frames: action.frames });
    }
    // Replayed under human rules, exactly as it happened: your own coins, key and switch are
    // yours, and they now also become evidence the pet can read about how items behave.
    const trace = runExperiment(lab.world, { id: `human-${Date.now().toString(36)}`, segments, origin: 'human',
      start: recording.from, note: '你亲手做的一次示范', role: 'human' });
    lab.traces = [...lab.traces, trace].slice(-MAX_TRACES);
    const items = trace.progress.coins.length ? `，你顺手收了 ${trace.progress.coins.length} 枚金币` : '';
    logEvent('demo', `你的示范记成一条带标签实验：${recording.frames} 帧，起点 x=${Math.round(recording.from.x)} → 终点 x=${Math.round(human.x)}（${human.dead ? '跌落' : '存活'}）${items}，花了 0 次模型调用`);
    saveLab(); status = `已把你的 ${recording.frames} 帧操作记成一次带标签的实验；它还得自己归纳出结论。`;
  } else if (recording.actions.length) {
    const { frames, ...sample } = recording; sample.to = { ...human }; sample.outcome = human.dead ? 'fell' : 'survived';
    samples.push(sample); samples = samples.slice(-8); save();
    logEvent('demo', `示范课：记录你 ${frames} 帧真实操作（${sample.outcome === 'fell' ? '跌落反例' : '存活'}），起点 x=${Math.round(sample.from.x)} → 终点 x=${Math.round(sample.to.x)}，花了 0 次模型调用`);
    noteMemory('你的示范', false);
    recording = null;
    status = '已记录你的真实操作。正在把它总结成规则…';
    update();
    learnLesson();
    return;
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
  // Co-op: the pet waiting at the goal must not freeze the world — the human still has to arrive.
  if (paused || !ready || (progress.won && (!coopShared || humanProgress.won))) return; tick++;
  const input = { move: Number(keys.right) - Number(keys.left), jump: keys.jump };
  if (recording && (recording.frames || input.move || input.jump)) {
    const last = recording.actions.at(-1);
    if (last && last.move === input.move && last.jump === input.jump && last.frames < 90) last.frames++;
    else if (recording.actions.length < 12) recording.actions.push({ ...input, frames: 1 });
    else finishDemo();
    if (recording) recording.frames++;
  }
  step(human, input, level, humanProgress, 'human', physics(), coopShared);
  if (coopShared) { const wasOn = coopShared.switchOn; latchPlates(level, coopShared, human, pet); if (!wasOn && coopShared.switchOn) logEvent('win', '两块压力板被同时踩住：门永久打开了，双方各自走到终点就算一起通关'); syncShared(); }
  if (recording && (recording.frames >= 240 || human.dead)) finishDemo();
  // Whoever falls respawns and restarts their own attempt; the other side is untouched.
  if (human.dead) {
    humanFalls++; human = actor(level.spawn); humanProgress = freshProgress();
    logEvent('fall', `你摔了（第 ${humanFalls} 次），已复活回到起点、自己的金币和机关重置`);
  }
  if (humanProgress.won && !humanWon) {
    humanWon = true;
    if (coopShared && !progress.won) {
      logEvent('win', '你到达了终点：等小精灵也到终点，才算一起通关');
      status = '你到了终点。小精灵那边还在路上——它到了才算一起通关。';
    } else {
      humanWins++;
      logEvent('win', coopShared ? `你们一起通关了第 ${stageId} 关：配合踩板、收齐金币、取钥匙、双双到达终点` : `你自己通关了第 ${stageId} 关：收齐 ${level.coins.length} 枚金币、取钥匙、开机关、到终点`);
      markCleared(stageId, '你');
      const next = nextStage(stageId);
      status = next ? `你${coopShared ? '们一起' : ''}通关了第 ${stageId} 关。第 ${next} 关「${stageInfo(next).name}」已解锁，也可以让小精灵再来一次这一关。`
        : `你${coopShared ? '们一起' : ''}通关了最后一关。`;
    }
  }
  if (enabled && !recording) {
    if (queue.length) {
      const action = queue[0];
      const before = { x: pet.x, y: pet.y, key: progress.key, switchOn: progress.switchOn, coins: [...progress.coins] };
      step(pet, mode === 'lab' && lab.world ? channelInput(lab.world, action) : action, level, progress, 'pet', physics(), coopShared);
      if (pet.grounded) attemptTakeOff = { x: pet.x, y: pet.y };
      if (pet.dead && attemptFellAt == null) attemptFellAt = Math.round(pet.x);
      if (coopShared) { const wasOn = coopShared.switchOn; latchPlates(level, coopShared, human, pet); if (!wasOn && coopShared.switchOn) { attemptEvents.push('和主人同时踩住两块压力板，门开了'); logEvent('win', '两块压力板被同时踩住：门永久打开了，双方各自走到终点就算一起通关'); } syncShared(); }
      if (mode !== 'lab') noteAttemptEvents(before);
      if (--action.frames <= 0) queue.shift();
      if (pet.dead) { falls++; queue = []; if (!prefetched?.afterDeath) prefetched = null; petRespawnAt = tick + 45; logEvent('fall', `小精灵跌落（第 ${falls} 次），45 帧后复活重开`); status = '小精灵摔了，正在复活重开；它自己的进度会重置，学过的东西保留。'; }
      if (!queue.length) {
        if (modelPlan) finishModelPlan(); else scoreLabPrediction();
        feedback = `从 ${JSON.stringify(planStart)} 到 ${JSON.stringify(pet)}；${pet.dead ? '跌落' : progress.won ? '完成' : '动作完成'}，物品 ${JSON.stringify(progress)}`;
        if (mode !== 'lab') { scoreLessonPending(); recordAttempt(); maybeAutoReflect(); }
      } else prefetch();
    } else if (prefetched && (!prefetched.afterDeath || !pet.dead)) {
      const { result } = prefetched; prefetched = null;
      adoptPlan(result, false);
      prefetch();
    } else decide();
  }
  if (progress.won && !petWonLogged) {
    petWonLogged = true;
    if (coopShared && !humanProgress.won) {
      enabled = false; idle();
      logEvent('win', `${petName}到达了终点：在等你过去，双方都到才算一起通关`);
      status = `${petName}到终点了，在等你。你走到终点就算一起通关。`;
    } else {
      enabled = false; idle();
      if (!clearedStages.includes(stageId)) {
        petWins++; markCleared(stageId, petName);
        logEvent('win', coopShared
          ? `你们一起通关了第 ${stageId} 关「${stageInfo(stageId).name}」（本轮模型调用 ${calls} 次、跌落 ${falls} 次）`
          : `${petName}自己通关了第 ${stageId} 关「${stageInfo(stageId).name}」（本轮模型调用 ${calls} 次、跌落 ${falls} 次）`);
        // Consolidate the win while it is fresh: the successful run becomes rules, not just a log line.
        if (mode !== 'lab' && autoReflects < 3 && attempts.length) {
          autoReflects++; recordAttempt();
          logEvent('learn', '它自己通关了，自动把这次成功固化成规则');
          learnLesson('它自己通关了这一关：把这次成功里的关键做法固化成规则，供以后的关卡参考');
        }
      }
      const next = nextStage(stageId);
      status = next ? `${petName}${coopShared ? '和你们一起' : '自己'}收齐金币、取钥匙、开门、到达终点。第 ${next} 关「${stageInfo(next).name}」已解锁。`
        : `${petName}通关了最后一关「${stageInfo(stageId).name}」。`;
      $('#next-level').textContent = next ? `进入第 ${next} 关：${stageInfo(next).name} →` : '再练一次 →';
    }
  }
  // A fall is survivable for both sides: the pet comes back on its own and keeps trying.
  if (pet.dead && petRespawnAt && tick >= petRespawnAt) {
    pet = actor(level.spawn); progress = freshProgress(); petRespawnAt = 0;
    logEvent('fall', '小精灵已复活：位置和它自己的进度重置，机制手册、实验记录和世界模型保留');
    status = '小精灵已复活重开，继续自己闯；你可以随时「回去示范」。';
  }
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
  level = lab.world.level; human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); resetCoop();
  calls = falls = 0; feedback = ''; paused = false; $('#soundless-pause').textContent = '暂停';
  $('#level-source').textContent = `空白实验室 · ${labWorldName()} · 机制保密`;
  logEvent('world', `换到${labWorldName()}（种子 ${seed}）：通道含义和物理参数重新隐藏${carried.length ? `；上一个世界确认过的 ${carried.length} 条结论降级为待复核` : '；它对这个世界一无所知'}`);
  status = carried.length ? `换到${labWorldName()}：上一个世界确认过的 ${carried.length} 条结论自动变成待复核，它得在这里重新验证。`
    : `${labWorldName()}：一个小精灵，三个无名通道，它对这个世界一无所知。`;
  $('#lab-enter').hidden = true; $('#back-classic').hidden = false; saveLab(); update();
}
function backToClassic() {
  mode = 'classic'; cancel(); recording = null;
  $('#lab-enter').hidden = false; $('#back-classic').hidden = true;
  goToStage(stageId, '（回到课程）');
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
function renderLog() {
  const when = at => { const d = new Date(at || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
  const box = $('#lab-log');
  const selection = LOG_FILTERS[logFilter] || LOG_FILTERS.all;
  const entries = [...(lab.log || [])].reverse().filter(entry => selection.includes(entry.kind));
  if (!entries.length) {
    box.textContent = (lab.log || []).length
      ? '这个筛选下暂时没有记录，换一个筛选看看。'
      : '还没有记录。它会记录：每一关的进入与通关、你的示范、模型每次做了什么选择（看到什么、选了什么、预测什么）、记忆因此变了什么、双方的跌落与复活。';
    return;
  }
  // One element per line so the time, the category chip and the text each keep their own
  // column instead of running together in a wall of monospaced text.
  box.replaceChildren(...entries.map(entry => {
    const row = document.createElement('div'); row.className = `log-row log-${entry.kind}`;
    const time = document.createElement('span'); time.className = 'log-time'; time.textContent = when(entry.at);
    const kind = document.createElement('span'); kind.className = 'log-kind'; kind.textContent = LOG_KINDS[entry.kind] || entry.kind;
    const text = document.createElement('span'); text.className = 'log-text'; text.textContent = entry.text;
    row.append(time, kind, text);
    return row;
  }));
}
// The right column is the memory itself: what is stored, what the next call will be given,
// and what the last few calls changed. Weights never change, so this is the whole story.
function renderMemory() {
  const learning = !!lab.world;
  const lines = [];
  lines.push('模型权重不会变：每次调用都把下面这些重新塞进提示词。所以"学到"= 这里的内容变了。');
  lines.push('');
  lines.push(learning ? `【知识库】${lab.notebook.length} 条（每次送全部）` : `【通用手册】${generalNotes.length} 条（全关卡通用，每次送全部）＋【本关笔记】${lessonNotes.length} 条（确认 ${lessonNotes.filter(n => n.state === '确认').length} 条）`);
  if (!learning && generalNotes.length) generalNotes.slice(-5).forEach((n, i) => lines.push(`　${i + 1}. 【${n.state}】${n.claim}（证据 ${n.evidence.length}）`));
  const memory = Array.isArray(lab.memory) && lab.memory.length ? lab.memory : snapshotMemory(learning);
  if (!memory.length) lines.push(learning ? '　还是空的：先做实验台或让它归纳。' : '　还是空的：点「让它总结」，把你的示范和它的尝试变成规则。');
  else memory.slice(-10).forEach((entry, i) => lines.push(`　${i + 1}. ${entry.text}`));
  if (!learning) {
    lines.push('');
    lines.push(`【它的尝试】最近 ${attempts.length} 次（它每次决策都会看到）`);
    if (!attempts.length) lines.push('　还没有。点「开始 / 继续模型闯关」让它自己试。');
    attempts.slice(-6).reverse().forEach(entry => lines.push(`　${entry.outcome === 'fell' ? '✗' : entry.outcome === 'won' ? '✓' : '·'} x=${Math.round(entry.from.x)}→${Math.round(entry.to.x)} ${entry.outcome === 'fell' ? '掉下去了' : entry.outcome === 'won' ? '通关' : '还活着'}`));
    lines.push('');
    lines.push(`【示范记忆】${samples.length} 条（未蒸馏 ${freshSamples().length} 条直接送决策；已蒸馏的由规则代替，只供复盘）`);
    if (!samples.length) lines.push('　还没有：点「回去示范」录一次，它会先自己总结成规则。');
    samples.slice(-4).forEach((s, i) => lines.push(`　${i + 1}. ${s.level.title} · x=${Math.round(s.from.x)}→${Math.round(s.to.x)} ${s.outcome === 'fell' ? '摔了' : '成功'}${s.distilled ? '（已蒸馏成规则）' : ''}`));
  }
  lines.push('');
  lines.push('【本次变化】');
  lines.push(...memoryChangeLines());
  if (learning) {
    lines.push('');
    lines.push(...labKnowsText().split('\n').filter(line => line.startsWith('通道') || line.startsWith('手册统计') || line.includes('世界模型')));
  }
  lines.push('');
  lines.push('【这一关】');
  lines.push(`　${learning ? `世界 ${lab.index}` : `第 ${stageId} 关「${stageInfo(stageId).name}」`}：模型调用 ${calls}/16 · 它跌落 ${falls} 次 · 你跌落 ${humanFalls} 次`);
  lines.push(`　它现在想：「${lastGoal || '还没开始'}」`);
  lines.push(`　通关：它自己 ${petWins} 次 · 你 ${humanWins} 次${clearedStages.length ? ` · 已通过 ${clearedStages.length}/${STAGES.length} 关` : ''}`);
  $('#lab-knows').textContent = lines.join('\n');
}
function updateLab() {
  // The log belongs to the whole page, not to the lab: falls, rounds and demonstrations
  // happen in the classic lesson too, and the player must be able to read them there.
  renderLog();
  renderLogFilters();
  renderMemory();
  if (!lab.world) {
    $('#lab-world').textContent = '还没开始';
    $('#lab-notebook').textContent = '还没有进入实验室。';
    $('#lab-score').textContent = '点“进入实验室”抽第一个世界。';
    $('#lab-model-out').textContent = '';
    $('#lab-answer').textContent = '';
    renderStages();
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
  $('#lab-knows').textContent = labKnowsText(knows);
}
function labKnowsText(knows = summarizeKnowledge({ notebook: lab.notebook, worldModel: lab.worldModel, plan: lab.plan,
  modelRuns: lab.modelRuns || [], accuracy: lab.accuracy, answer: lab.answer })) {
  const channelLines = knows.channels.map(c => {
    if (!c.known) return `通道 ${c.channel}：还不知道${c.actual ? `（真相是${roleName(c.actual)}）` : ''}`;
    const verdict = c.agrees === null ? '' : c.agrees ? '　✓ 和真相一致' : '　✗ 和真相不符';
    return `通道 ${c.channel}：${c.claims.join('；')}${verdict}`;
  });
  return [
    `实验室：${labWorldName()}（种子 ${lab.seed}）`,
    ...knows.lines,
    ...channelLines,
    `手册统计：确认 ${knows.confirmed} 条 · 待验证 ${knows.pending} 条 · 猜想 ${knows.hypotheses} 条 · 已推翻 ${knows.refuted} 条`,
  ].join('\n');
}
// The ladder bar: cleared stages are replayable, the next one is open, the rest are locked.
function renderStages() {
  const bar = $('#stage-bar');
  if (mode === 'lab') { bar.replaceChildren(); return; }
  bar.replaceChildren(...stagePickerState(clearedStages, stageId).map(stage => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'stage-chip'; chip.dataset.stage = String(stage.id);
    chip.disabled = stage.locked;
    chip.setAttribute('aria-current', stage.current ? 'true' : 'false');
    chip.textContent = `${stage.cleared ? '✓ ' : stage.locked ? '🔒 ' : ''}第 ${stage.id} 关 · ${stage.name}`;
    chip.title = stage.locked ? `先过第 ${stage.id - 1} 关` : `${stage.skill}提示：${stage.hint}`;
    return chip;
  }));
}
const LOG_KINDS = { world: '世界', round: '重开', prior: '先验', battery: '实验台', demo: '你的示范', induce: '归纳', learn: '学到', model: '世界模型', plan: '规划', act: '行动', choice: '它选择', predict: '预测', reveal: '揭晓', error: '失败', fall: '跌落', win: '通关' };
// The player asked for "what the model decided", so the log can be narrowed to exactly that
// instead of making them read the plumbing around every call.
const LOG_FILTERS = {
  all: Object.keys(LOG_KINDS),
  choice: ['choice', 'plan'],
  memory: ['learn', 'induce', 'model', 'demo', 'battery', 'prior', 'world', 'round', 'reveal'],
  trouble: ['error', 'fall', 'predict', 'win'],
};
function renderLogFilters() {
  const bar = $('#log-filter');
  bar.replaceChildren(...Object.entries({ all: '全部', choice: '只看它的选择', memory: '只看记忆变化', trouble: '只看出事与通关' }).map(([key, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'log-filter-chip'; chip.dataset.filter = key;
    chip.setAttribute('aria-current', key === logFilter ? 'true' : 'false');
    chip.textContent = label;
    return chip;
  }));
}
function update() {
  const side = (p, label) => `${label} 金币 ${p.coins.length}/${level.coins.length} · ${p.key ? '已取钥匙' : '先取钥匙'} · ${p.switchOn ? '门已开' : '回头开机关'}${p.won ? ' · 已通关' : ''}`;
  $('#level-title').textContent = level.title;
  $('#objective').textContent = `${side(humanProgress, '你')}　|　${side(progress, petName)}`;
  $('#pet-status').textContent = paused ? '已暂停。' : status;
  $('#attempts').textContent = `模型 ${calls}/16 次 · ${petName}跌落 ${falls} 次 · 你跌落 ${humanFalls} 次`;
  $('#round-info').textContent = `第 ${roundIndex} 轮 · 本轮示范 ${roundDemos} 次`;
  $('#lesson-count').textContent = `${samples.length} 次示范`; $('#learning-note').textContent = recording ? '正在录制你的真实按键。' : '未蒸馏的示范直接送决策；被复盘消化过的示范由规则代替，不再重复送。未修改模型权重。';
  $('#lessons').textContent = samples.slice(-4).map((s, i) => `${i + 1}. ${s.level.title} · ${s.outcome === 'fell' ? '跌落反例' : '操作示范'}`).join('　');
  $('#finish-demo').hidden = !recording; $('#finish').hidden = !progress.won; $('#retry-pet').disabled = !ready || pending;
  updateLab();
}
function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
function label(text, x, y, color = '#42624e', size = 14) { ctx.fillStyle = color; ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(text, x, y); }
function drawActor(a, isPet, cam) {
  const x = a.x - cam, y = a.y;
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
const PANE_HEIGHT = 470;
function cameraFor(x, width) { return Math.max(0, Math.min(Math.max(0, level.width - width + 30), x - width * .42)); }
// A pane is one player's own view: their camera, their actor, their coins, key, switch and
// door. Nothing from the other side is drawn here — that is what "independent" looks like.
function drawPane(top, cam, who) {
  const width = canvas.width, prog = who === 'pet' ? progress : humanProgress;
  ctx.save(); ctx.beginPath(); ctx.rect(0, top, width, PANE_HEIGHT); ctx.clip(); ctx.translate(0, top);
  rect(0, 0, width, PANE_HEIGHT, '#dceee3');
  for (let i = 0; i < 9; i++) { const x = i * 190 - cam * .3; rect(x, 285, 170, 110, '#c5dcbd'); rect(x + 30, 240, 100, 50, '#c5dcbd'); rect(x + 20, 75 + i % 3 * 20, 75, 15, '#f6f9e8'); }
  rect(0, 415, width, 55, '#7dbdb7');
  for (const p of level.platforms) { rect(p.x - cam, p.y, p.w, p.y === 400 ? 70 : 20, '#bbad82'); rect(p.x - cam, p.y, p.w, 8, '#63915c'); }
  level.coins.forEach((coin, i) => { if (!prog.coins.includes(i)) { rect(coin.x - cam - 6, coin.y - 8, 12, 16, '#f4cf62'); rect(coin.x - cam - 1, coin.y - 5, 3, 10, '#bd853b'); } });
  if (!prog.key) { label('⚿', level.key.x - cam, level.key.y + 5, '#ad752e', 26); label('钥匙', level.key.x - cam, level.key.y - 25, '#6c7446', 12); }
  if (coopShared) {
    level.coop.plates.forEach((plate, i) => {
      const occupied = [human, pet].some(a => !a.dead && Math.abs(a.x - plate.x) < 22 && Math.abs(a.y - 12 - plate.y) < 26);
      rect(plate.x - cam - 14, plate.y + 3, 28, 9, coopShared.switchOn ? '#71ad63' : occupied ? '#e2c04f' : '#c98989');
      label(coopShared.switchOn ? '门已开' : `压力板${i + 1}`, plate.x - cam, plate.y - 20, '#4d6845', 12);
    });
  } else {
    const sx = level.switch.x - cam; rect(sx - 14, level.switch.y + 3, 28, 9, prog.switchOn ? '#71ad63' : '#d7a152');
    label(prog.switchOn ? '已开门' : '带钥匙回来', sx, level.switch.y - 20, '#4d6845', 12);
  }
  if (!prog.switchOn) { rect(level.door.x - cam - 8, level.door.y, 16, level.door.h, '#8c7966'); label('锁门', level.door.x - cam, level.door.y - 12, '#655444', 12); }
  rect(level.goal.x - cam - 3, level.goal.y - 70, 6, 70, '#557156'); rect(level.goal.x - cam + 3, level.goal.y - 70, 30, 20, '#eccb71');
  label('终点', level.goal.x - cam, level.goal.y - 82);
  if (who === 'pet') { if (!pet.dead) drawActor(pet, true, cam); } else drawActor(human, false, cam);
  label(who === 'pet' ? `镜头跟${petName} · 金币 ${prog.coins.length}/${level.coins.length}` : `镜头跟你 · 金币 ${prog.coins.length}/${level.coins.length}`, width - 96, 22, who === 'pet' ? '#39683c' : '#396c88', 13);
  if (prog.won) label('已通关', width - 96, 42, '#7a5a24', 13);
  ctx.restore();
}
function draw() {
  const width = Math.max(500, Math.round(canvas.clientWidth)); if (canvas.width !== width) canvas.width = width;
  const height = splitView ? PANE_HEIGHT * 2 : PANE_HEIGHT; if (canvas.height !== height) canvas.height = height;
  if (splitView) {
    cameraPet += (cameraFor(pet.x, width) - cameraPet) * .12;
    cameraHuman += (cameraFor(human.x, width) - cameraHuman) * .12;
    drawPane(0, cameraPet, 'pet');
    drawPane(PANE_HEIGHT, cameraHuman, 'human');
    rect(0, PANE_HEIGHT - 4, width, 4, '#6f8f7c');
  } else {
    const who = $('#camera').value === 'pet' ? 'pet' : 'human';
    const target = who === 'pet' ? pet : human;
    cameraX += (cameraFor(target.x, width) - cameraX) * .12;
    drawPane(0, cameraX, who);
  }
  if (pending) label('模型观察中 · 你可以继续', width / 2, 30, '#3c6450', 15);
  if (paused) { rect(0, 0, width, canvas.height, '#eef4e299'); label('暂停练习', width / 2, canvas.height / 2, '#2f5545', 25); }
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
  level = lab.world.level; human = actor(level.spawn); pet = actor(level.spawn); progress = freshProgress(); humanProgress = freshProgress(); resetCoop();
  calls = falls = humanFalls = 0; feedback = ''; paused = false; lab.pending = null; $('#soundless-pause').textContent = '暂停';
  $('#level-source').textContent = `空白实验室 · ${labWorldName()} · 机制保密`;
  logEvent('world', `回到${labWorldName()}：手册 ${summarizeNotebook(lab.notebook).length} 条、实验 ${lab.traces.length} 次、累计模型调用 ${lab.calls} 次`);
  status = '回到这个世界的实验室：机制手册和实验记录都还在。';
  saveLab(); $('#lab-enter').hidden = true; $('#back-classic').hidden = false; update(); canvas.focus();
}
$('#stage-bar').addEventListener('click', event => {
  const chip = event.target.closest('[data-stage]');
  if (chip && !chip.disabled) goToStage(Number(chip.dataset.stage));
});
$('#log-filter').addEventListener('click', event => {
  const chip = event.target.closest('[data-filter]');
  if (chip) { logFilter = chip.dataset.filter; update(); }
});
$('#toggle-sidebars').addEventListener('click', () => {
  sidebars = !sidebars;
  document.body.classList.toggle('no-sidebars', !sidebars);
  $('#toggle-sidebars').textContent = sidebars ? '收起两侧栏' : '展开两侧栏';
});
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
$('#restart').addEventListener('click', () => restartRound());
$('#lesson-learn').addEventListener('click', () => learnLesson());
$('#split').addEventListener('change', event => { splitView = event.target.checked; saveView(); update(); });
$('#soundless-pause').addEventListener('click', () => { paused = !paused; idle(); $('#soundless-pause').textContent = paused ? '继续' : '暂停'; update(); canvas.focus(); });
$('#generate').addEventListener('click', generate);
$('#use-level').addEventListener('click', () => { if (prepared) { resetLevel(prepared.level); $('#level-source').textContent = `大模型生成 · ${prepared.model} · 物理验证通过`; prepared = null; $('#use-level').hidden = true; } });
$('#next-level').addEventListener('click', () => {
  const next = nextStage(stageId);
  if (next && clearedStages.includes(stageId)) goToStage(next, '（上一关已通过）');
  else { restartRound(); $('#level-intent').focus(); }
});
$('#forget').addEventListener('click', () => { cancel(); samples = []; recording = null; save(); status = '本浏览器中这只精灵的跳跃示范已清空。'; update(); });
init(); requestAnimationFrame(frame);
