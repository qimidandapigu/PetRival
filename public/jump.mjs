import { makeLevel, actor, stepActor, touchObjects, checkpoint, freshProgress, gapAhead, JumpMemory, DemonstrationRecorder, PetController, PHYSICS } from './jump-engine.mjs';
import { defaultAppearance, validateAppearance, petDisplayName } from '/shared/pet.mjs';
const $ = selector => document.querySelector(selector);
const canvas = $('#jump-canvas'), ctx = canvas.getContext('2d');
let levelIndex = 0, level = makeLevel(), human = actor(110), pet = actor(65), progress = freshProgress();
let memory = new JumpMemory(), recorder = new DemonstrationRecorder(memory), controller = new PetController(memory);
let storageKey = 'petrival.jump.v1.guest', petName = '小精灵', appearance = defaultAppearance('xiaotangyuan');
let paused = false, ready = false, waiting = false, manualTeaching = false, humanCheckpoint = 80, petCheckpoint = 80, falls = 0, tick = 0, cameraX = 0;
let previousTime = 0, accumulator = 0, flash = '', flashUntil = 0, lastMemorySize = -1;
const keys = { left: false, right: false, jump: false }, keyboard = new Set(), pointers = new Map();
const idle = () => { keyboard.clear(); pointers.clear(); keys.left = keys.right = keys.jump = false; };
function syncKeys() { for (const key of Object.keys(keys)) keys[key] = keyboard.has(key) || [...pointers.values()].includes(key); }
function announce(message, seconds = 4) { flash = message; flashUntil = tick + seconds * 60; }
function readMemory() {
  try { memory = new JumpMemory(JSON.parse(localStorage.getItem(storageKey) || 'null')); }
  catch { memory = new JumpMemory(); $('#save-note').textContent = '本次无法读取本机笔记，可以继续练习；关闭页面后学习记录可能丢失。'; }
  recorder = new DemonstrationRecorder(memory); controller = new PetController(memory); lastMemorySize = -1;
}
function saveMemory() {
  try { localStorage.setItem(storageKey, JSON.stringify(memory.json())); }
  catch { $('#save-note').textContent = '浏览器未允许保存笔记。本次练习仍可继续，关闭后不会保留。'; }
}
async function init() {
  // Reuse an existing pet's cosmetic identity when one is accessible. No new
  // adoption, cloud score mutation, or model call is made by this standalone game.
  try {
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(4000) });
    if (response.ok) {
      const state = await response.json();
      if (state.mine) {
        storageKey = `petrival.jump.v1.pet.${state.mine.id}`; petName = petDisplayName(state.mine.name);
        try { appearance = validateAppearance(state.mine.appearance || defaultAppearance(state.mine.species)); } catch { /* safe default */ }
      }
    }
  } catch { /* A guest can play locally without waiting for the account service. */ }
  readMemory(); ready = true; update();
}
function resetLevel(index = levelIndex) {
  idle(); levelIndex = index; level = makeLevel(index); human = actor(110); pet = actor(65); progress = freshProgress();
  humanCheckpoint = petCheckpoint = 80; falls = 0; waiting = manualTeaching = false; cameraX = 0;
  recorder.pending = null; controller.reset(); $('#level').value = String(index); $('#finish').hidden = true;
  announce('你先示范，小精灵会一起尝试。'); update();
}
function retryPet() { pet = actor(petCheckpoint); controller.reset(); waiting = manualTeaching = false; announce('它带着学到的动作，再试一次。'); }
function teach() {
  human = actor(petCheckpoint); recorder.pending = null; waiting = true; manualTeaching = true;
  $('#camera').value = 'human'; idle(); paused = false; $('#soundless-pause').textContent = '暂停';
  announce('从它的落脚点出发：向右走，按住空格跳过小溪。安全落地后它会再试。', 12); canvas.focus();
}
function advance() {
  if (!ready || paused || progress.won) return;
  tick++;
  const input = { move: Number(keys.right) - Number(keys.left), jump: keys.jump };
  recorder.before(human, input, level); stepActor(human, input, level);
  const learned = recorder.after(human);
  if (human.dead) {
    human = actor(humanCheckpoint); recorder.pending = null;
    announce('你回到了上一个落脚点。这次跌落不会写入它的笔记。');
  } else if (human.grounded) humanCheckpoint = checkpoint(human, level);
  if (learned) {
    saveMemory(); announce('它记住了你刚才的起跳位置和按键时长！');
    if (waiting) retryPet();
  }
  if (!waiting) {
    stepActor(pet, controller.action(pet, level), level); touchObjects(pet, 'pet', level, progress);
    if (pet.dead) {
      falls++; pet = actor(petCheckpoint); controller.reset(); waiting = true;
      announce('它掉进小溪了，正在等你示范。你可以继续跳，也可以回到它身边。', 12);
    } else if (pet.grounded) petCheckpoint = checkpoint(pet, level);
    if (!progress.won && pet.x >= level.width - 15) {
      waiting = true; announce('还有金币没拿到。点“本关重来”，试着调整示范的落点。', 12);
    }
  }
  if (progress.won) { $('#finish').hidden = false; idle(); }
  if (tick % 6 === 0 || learned || progress.won) update();
}
function update() {
  $('#objective').textContent = `小精灵收集 ${progress.coins.length} / ${level.coins.length} 枚金币 · ${progress.switchOn ? '机关已开' : '机关未开'}`;
  $('#attempts').textContent = `小精灵跌落 ${falls} 次`;
  $('#pet-status').textContent = !ready ? '正在打开学习笔记，你马上就能开始。' : paused ? '已暂停，点击“继续”回来练习。' :
    progress.won ? `${petName}自己拿齐了金币，打开机关，到达终点。` : tick < flashUntil ? flash : waiting ?
    (manualTeaching ? '它在看你的示范。成功落地后，就轮到它。' : '它还没通过这段，等你回来教。') : controller.mode;
  if (lastMemorySize !== memory.demonstrations) {
    lastMemorySize = memory.demonstrations;
    $('#lesson-count').textContent = `${memory.clips.length} 次示范`;
    $('#learning-note').textContent = memory.clips.length ? '这些跳法来自你的成功示范。换个位置也能试；遇到更宽的小溪，需要再教。' : '还没有成功跨坑的示范。平地乱跳和掉进水里的动作不会记入。';
    const widths = [...new Set(memory.clips.map(c => c.width))];
    $('#lessons').replaceChildren(...widths.map(width => {
      const tag = document.createElement('span'); tag.className = 'lesson'; tag.textContent = `${width <= 72 ? '窄' : width <= 92 ? '中等' : '宽'}小溪 · ${memory.clips.filter(c => c.width === width).length} 次示范`; return tag;
    }));
  }
}
function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
function label(text, x, y, color = '#42624e', size = 14) { ctx.fillStyle = color; ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(text, x, y); }
function drawActor(a, isPet) {
  const x = a.x - cameraX, y = a.y;
  if (x < -50 || x > canvas.width + 50) return;
  ctx.save(); ctx.globalAlpha = isPet ? 1 : .78;
  rect(x - 14, Math.min(y, PHYSICS.floor) + 1, 28, 4, '#25493725');
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
  const width = Math.max(500, Math.round(canvas.clientWidth));
  if (canvas.width !== width) canvas.width = width;
  const target = $('#camera').value === 'pet' ? pet : human;
  const desired = Math.max(0, Math.min(level.width - width + 30, target.x - width * .42));
  cameraX += (desired - cameraX) * .12;
  const w = canvas.width, h = canvas.height;
  rect(0, 0, w, h, '#dceee3');
  // Original pixel scenery, sharing the courtyard palette.
  for (let i = 0; i < 7; i++) {
    const x = i * 240 + 40 - cameraX * .23;
    rect(x, 97 + i % 3 * 16, 76, 12, '#f6f9e8'); rect(x + 17, 85 + i % 3 * 16, 40, 24, '#f6f9e8');
  }
  for (let i = -1; i < 10; i++) {
    const x = i * 190 - cameraX * .4;
    rect(x, 245, 170, 85, '#c5dcbd'); rect(x + 25, 217, 117, 35, '#c5dcbd'); rect(x + 53, 192, 60, 30, '#c5dcbd');
  }
  rect(0, 355, w, 115, '#7dbdb7');
  for (let i = 0; i < 30; i++) rect(i * 63 - cameraX % 63 + (tick % 70) * .15, 380 + i % 4 * 14, 24, 3, '#c2e4ce');
  const segments = []; let start = 0;
  for (const [s, e] of level.gaps) { segments.push([start, s]); start = e; }
  segments.push([start, level.width]);
  for (const [s, e] of segments) {
    rect(s - cameraX, 330, e - s, 140, '#bbad82'); rect(s - cameraX, 330, e - s, 12, '#63915c'); rect(s - cameraX, 342, e - s, 6, '#98b574');
    for (let x = s + 12; x < e; x += 40) { rect(x - cameraX, 362, 14, 6, '#9f916c'); rect(x + 15 - cameraX, 408, 12, 5, '#a69870'); }
  }
  for (const [s, e] of level.gaps) {
    label('小溪', (s + e) / 2 - cameraX, 421, '#376e69', 12);
    // A hint to the human, never consumed by the pet controller.
    label('在岸边起跳', s - 65 - cameraX, 277, '#698650', 12);
    rect(s - 49 - cameraX, 316, 20, 3, '#e7da96');
  }
  level.coins.forEach((coin, i) => {
    if (progress.coins.includes(i)) return;
    const x = coin.x - cameraX;
    rect(x - 7, coin.y - 9, 14, 18, '#bd853b'); rect(x - 5, coin.y - 10, 10, 17, '#f4cf62'); rect(x - 1, coin.y - 6, 3, 10, '#ffecac');
  });
  const sx = level.switchX - cameraX, gx = level.goalX - cameraX;
  rect(sx - 16, 322, 32, 8, '#4b6860'); rect(sx - 11, progress.switchOn ? 322 : 316, 22, progress.switchOn ? 4 : 10, progress.switchOn ? '#83bd71' : '#e5ba63');
  label(progress.switchOn ? '机关已开' : '精灵踩下机关', sx, 296, '#4f6a4a', 12);
  rect(gx - 4, 231, 8, 99, '#557156'); rect(gx + 4, 234, 37, 24, progress.switchOn ? '#eccb71' : '#a6b6a0');
  label('终点', gx + 5, 215);
  drawActor(human, false); drawActor(pet, true);
  // Keep a separated companion findable in long levels.
  const other = target === human ? pet : human;
  if (other.x - cameraX < 15 || other.x - cameraX > w - 15) label(`${other.x < cameraX ? '← ' : ''}${target === human ? '小精灵' : '你'}${other.x > cameraX + w ? ' →' : ''}`, other.x < cameraX ? 45 : w - 48, 185, '#42654c', 14);
  if (paused) { rect(0, 0, w, h, '#eef4e299'); label('暂停练习', w / 2, 215, '#2f5545', 25); }
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
$('#retry-pet').addEventListener('click', () => { retryPet(); canvas.focus(); update(); });
$('#restart').addEventListener('click', () => { resetLevel(); canvas.focus(); });
$('#level').addEventListener('change', event => { resetLevel(Number(event.target.value)); canvas.focus(); });
$('#next-level').addEventListener('click', () => { resetLevel((levelIndex + 1) % 3); canvas.focus(); });
$('#soundless-pause').addEventListener('click', () => { paused = !paused; idle(); $('#soundless-pause').textContent = paused ? '继续' : '暂停'; update(); canvas.focus(); });
$('#forget').addEventListener('click', () => {
  if (!confirm('只清空当前这只精灵在本浏览器的跳跃示范笔记？宠物其他存档不会改变。')) return;
  memory = new JumpMemory(); recorder = new DemonstrationRecorder(memory); controller = new PetController(memory); saveMemory(); lastMemorySize = -1; resetLevel();
});
init(); requestAnimationFrame(frame);
