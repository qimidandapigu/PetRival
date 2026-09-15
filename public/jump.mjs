import { starterLevel, actor, step, progress as freshProgress, validateLevel, validateActions } from './jump-world.mjs';
import { defaultAppearance, validateAppearance, petDisplayName } from '/shared/pet.mjs';
const $ = s => document.querySelector(s), canvas = $('#jump-canvas'), ctx = canvas.getContext('2d');
let level = starterLevel(), human = actor(level.spawn), pet = actor(level.spawn), progress = freshProgress();
let appearance = defaultAppearance('xiaotangyuan'), petName = '小精灵', storageKey = 'petrival.jump.v2.guest';
let samples = [], recording = null, enabled = false, pending = false, paused = false, ready = false, epoch = 0, abort;
let queue = [], calls = 0, falls = 0, tick = 0, cameraX = 0, previousTime = 0, accumulator = 0;
let status = '你可以先练习。点击开始后，真实模型才会决定精灵的动作。', feedback = '', planStart, prepared = null;
const keys = { left: false, right: false, jump: false }, keyboard = new Set(), pointers = new Map();
const idle = () => { keyboard.clear(); pointers.clear(); keys.left = keys.right = keys.jump = false; };
function syncKeys() { for (const key of Object.keys(keys)) keys[key] = keyboard.has(key) || [...pointers.values()].includes(key); }
async function api(path, data, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || '服务暂不可用'); return result;
}
function save() { try { localStorage.setItem(storageKey, JSON.stringify(samples)); } catch { $('#save-note').textContent = '本浏览器无法保存示范；关页后可能丢失。'; } }
async function init() {
  try {
    await api('/api/session', {}, AbortSignal.timeout(5000));
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(5000) });
    if (response.ok) { const state = await response.json(); if (state.mine) {
      storageKey = `petrival.jump.v2.pet.${state.mine.id}`; petName = petDisplayName(state.mine.name);
      try { appearance = validateAppearance(state.mine.appearance || defaultAppearance(state.mine.species)); } catch {}
    } }
  } catch { status = '账号服务暂不可用；你仍能练习，模型开始时会提示连接结果。'; }
  try { const stored = JSON.parse(localStorage.getItem(storageKey) || '[]'); samples = (Array.isArray(stored) ? stored : []).slice(-8).filter(d => { try { validateLevel(d.level); validateActions(d.actions); return d.from && d.to; } catch { return false; } }); } catch {}
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
  pending = true; calls++; const current = epoch; abort = new AbortController(); planStart = { ...pet };
  status = '模型正在观察关卡和你的示范；你可以继续移动。'; update();
  try {
    const result = await api('/api/jump/decision', { level, actor: pet, progress, demonstrations: samples.slice(-4), note: $('#teacher-note').value, feedback }, AbortSignal.any([abort.signal, AbortSignal.timeout(100000)]));
    if (current !== epoch) return;
    if (result.method !== 'model') throw new Error('接口未返回真实模型动作，已暂停');
    queue = validateActions(result.actions).map(a => ({ ...a }));
    status = `${result.model}：${result.goal || '执行下一段动作'} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 参考 ${result.usedDemonstrations.length}/${result.demonstrationsProvided} 次示范`;
  } catch (e) { if (current === epoch) { enabled = false; status = `${e.name === 'TimeoutError' ? '模型等待超时' : e.message}；真人可继续，点击开始重试。`; } }
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
  if (recording.actions.length) {
    const { frames, ...sample } = recording; sample.to = { ...human }; sample.outcome = human.dead ? 'fell' : 'survived';
    samples.push(sample); samples = samples.slice(-8); save(); status = '已记录你的真实操作。下一次模型会参考它；这不代表已经学会。';
  } else status = '这次没有操作，未保存示范。';
  recording = null; update();
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
  step(human, input, level, progress, 'human');
  if (recording && (recording.frames >= 240 || human.dead)) finishDemo();
  if (human.dead) human = actor(level.spawn);
  if (enabled && !pending && !recording) {
    if (queue.length) {
      const action = queue[0]; step(pet, action, level, progress, 'pet'); if (--action.frames <= 0) queue.shift();
      if (pet.dead) { falls++; enabled = false; queue = []; status = '精灵跌落了。回去示范，或点击开始从出生点重试。'; }
      if (!queue.length) feedback = `从 ${JSON.stringify(planStart)} 到 ${JSON.stringify(pet)}；${pet.dead ? '跌落' : progress.won ? '完成' : '动作完成'}，物品 ${JSON.stringify(progress)}`;
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
function update() {
  $('#level-title').textContent = level.title;
  $('#objective').textContent = `精灵金币 ${progress.coins.length}/${level.coins.length} · ${progress.key ? '已取钥匙' : '先取钥匙'} · ${progress.switchOn ? '门已开' : '回头开机关'}`;
  $('#pet-status').textContent = paused ? '已暂停。' : status; $('#attempts').textContent = `模型 ${calls}/16 次 · 跌落 ${falls} 次`;
  $('#lesson-count').textContent = `${samples.length} 次示范`; $('#learning-note').textContent = recording ? '正在录制你的真实按键。' : '最近 4 次示范会作为上下文送给模型，未修改模型权重。';
  $('#lessons').textContent = samples.slice(-4).map((s, i) => `${i + 1}. ${s.level.title} · ${s.outcome === 'fell' ? '跌落反例' : '操作示范'}`).join('　');
  $('#finish-demo').hidden = !recording; $('#finish').hidden = !progress.won; $('#retry-pet').disabled = !ready || pending;
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
