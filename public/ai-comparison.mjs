import { replay } from '/shared/game.mjs';
const data = await (await fetch('/ai-comparison-data.json')).json();
const $ = s => document.querySelector(s);
let selected = data.levels.at(-1), position = 0, timer;
const seconds = ms => (ms / 1000).toFixed(1);
function stop() { clearInterval(timer); timer = null; $('#play').textContent = '播放对照'; }
function drawLane(prefix, trial) {
  const run = replay(selected.rows, trial.actions.slice(0, position)), s = run.state;
  $(`#${prefix}-board`).innerHTML = Array.from({ length: 64 }, (_, p) => `<div class="cell${s.walls.includes(p) ? ' wall' : ''}">${s.goals.includes(p) ? '<span class="goal">✧</span>' : ''}${s.boxes.includes(p) ? `<span class="box${s.goals.includes(p) ? ' done' : ''}">${s.goals.includes(p) ? '✓' : '×'}</span>` : ''}${s.player === p ? '<span class="pet">•ᴗ•</span>' : ''}</div>`).join('');
  $(`#${prefix}-stats`).textContent = `${trial.steps} 步 · ${seconds(trial.elapsedMs)} 秒`;
  $(`#${prefix}-progress`).textContent = `${run.won ? '✓ 两个箱子都到家了' : '回放中'} · 已执行 ${run.steps} 步`;
}
function draw() { drawLane('old', selected.baseline); drawLane('new', selected.candidate); $('#position').value = position; }
function choose(level) {
  stop(); selected = level; position = 0; $('#position').max = Math.max(level.baseline.actions.length, level.candidate.actions.length);
  for (const button of $('#levels').children) button.setAttribute('aria-pressed', String(button.textContent === level.id));
  draw();
}
for (const level of data.levels) {
  const button = document.createElement('button'); button.textContent = level.id; button.addEventListener('click', () => choose(level)); $('#levels').append(button);
  const row = document.createElement('tr');
  for (const text of [level.id, `${level.baseline.steps} / ${seconds(level.baseline.elapsedMs)}`, `${level.candidate.steps} / ${seconds(level.candidate.elapsedMs)}`, '两版均通关']) { const td = document.createElement('td'); td.textContent = text; row.append(td); }
  $('#results').append(row);
}
$('#play').addEventListener('click', () => {
  if (timer) return stop();
  if (position >= Number($('#position').max)) position = 0;
  $('#play').textContent = '暂停'; timer = setInterval(() => { position++; draw(); if (position >= Number($('#position').max)) stop(); }, 240);
});
$('#reset').addEventListener('click', () => choose(selected));
$('#position').addEventListener('input', e => { stop(); position = Number(e.target.value); draw(); });
choose(selected);
