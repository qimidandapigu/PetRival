import { petMarkup } from '/shared/pet.mjs';
for (const node of document.querySelectorAll('[data-pet]')) node.innerHTML = petMarkup({ species: node.dataset.pet });
const boards = [...document.querySelectorAll('.mini-board')];
const rows = ['######', '# .  #', '# $  #', '#  @ #', '#    #', '######'];
for (const board of boards) board.innerHTML = rows.join('').split('').map(cell => `<span class="cell ${cell === '#' ? 'wall' : cell === '$' ? 'box' : cell === '@' ? 'marker' : ''}">${cell === '$' ? '×' : cell === '.' ? '✳' : cell === '@' ? '●' : ''}</span>`).join('');
const stages = [
  ['关卡已备好 ✓', '你的守擂关', '对方的守擂关', '考题先准备，开局少等待。', '读取已有的守擂关卡即可开始，不必等现场出题。'],
  ['本局版本已锁定', '宠物 · 独立思考', '你 · 直接操作', '同一道题，各自给出答案。', '你和宠物挑战对方的关；对方也来挑战你们备好的题。'],
  ['下一关准备中', '本局 · 保持原题', '后续 · 验证新题', '这场照常玩，新题慢慢备。', '新关验证通过后供后续对局使用；没准备好，旧关仍可用。'],
];
for (const button of document.querySelectorAll('[data-step]')) button.addEventListener('click', () => {
  const step = Number(button.dataset.step);
  document.querySelectorAll('[data-step]').forEach(node => { const active = node === button; node.classList.toggle('active', active); node.setAttribute('aria-pressed', String(active)); });
  ['demo-tag', 'left-label', 'right-label', 'demo-title', 'demo-copy'].forEach((id, i) => { document.getElementById(id).textContent = stages[step][i]; });
  boards.forEach(board => board.classList.toggle('finished', step === 2));
});
