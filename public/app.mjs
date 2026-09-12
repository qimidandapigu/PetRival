import { parse, replay, renderRows, RULES } from '/shared/game.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avatar = (species, extra = '') => `<div class="garden-pet ${['sprout', 'fox', 'ghost'].includes(species) ? species : 'sprout'} ${extra}" aria-hidden="true"><i></i><b></b></div>`;
const duration = ms => `${Math.floor(Math.max(0, ms || 0) / 60000).toString().padStart(2, '0')}:${Math.floor(Math.max(0, ms || 0) % 60000 / 1000).toString().padStart(2, '0')}`;
const method = value => value === 'model' ? '大模型' : value === 'algorithm-starter' ? '算法入门题' : '算法 AI';
const status = run => ({ pending: '还未开始', running: '正在挑战', cleared: '已通关', failed: '未通关', not_applicable: '训练对手 · 无真人' }[run.status] || run.status);
let state, game = null, submitting = false, replayTimer = null, clockOffset = 0, refreshing = false;
const homeBindings = new WeakMap();
function bind(selector, event, handler) {
  const element = $(selector); if (!element) return;
  const previous = homeBindings.get(element);
  if (previous) element.removeEventListener(event, previous);
  element.addEventListener(event, handler); homeBindings.set(element, handler);
}

function notify(message, error = false) {
  const n = $('#notice'); n.textContent = message; n.hidden = false; n.classList.toggle('error', error);
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { n.hidden = true; }, 8000);
}
async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json(); if (!res.ok) throw new Error(body.error || '请求失败'); return body;
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    state = await api('/api/state'); clockOffset = state.now - Date.now(); render();
    if (game?.kind === 'challenge') {
      const m = state.challenges.find(c => c.id === game.id);
      if (m) { game.match = m; renderSide(); updateClock(); }
    }
  } catch (e) { notify(e.message, true); } finally { refreshing = false; }
}
function render() {
  $('#mode').textContent = state.mode === 'model' ? '大模型已配置' : '算法 AI · 无需密钥';
  const mine = state.mine;
  if (!document.activeElement?.closest('#my-pet') && (mine || !$('#adopt'))) {
    $('#my-pet').innerHTML = mine ? `
      <div class="section-heading"><span class="eyebrow">YOUR COMPANION</span><span class="badge ready">● 守擂关已就绪</span></div>
      <div class="pet-profile">${avatar(mine.species)}<div><h2>${escape(mine.name)} <span class="muted small">你的搭档</span></h2><p>${mine.preparing ? '正在后台准备下一关，当前关卡可照常挑战。' : '已经备好一道题，随时可以出战。'}</p><span class="badge">${method(mine.level.method)}</span> <span class="badge">${mine.defense ? '已开启异步守擂' : '暂未开启守擂'}</span></div><div class="pet-score"><strong>${mine.score}</strong><span>挑战积分</span></div></div>
      <form id="prepare"><label for="intent">下一关，想怎么出？</label><div class="input-row"><input id="intent" name="intent" maxlength="240" value="${escape(mine.intent)}" placeholder="例如：两个箱子，有点绕"><button class="primary" ${mine.preparing ? 'disabled' : ''}>${mine.preparing ? '备题中…' : '后台备新题 ↗'}</button></div></form>
      ${mine.prepareError ? `<p class="error-text">${escape(mine.prepareError)}</p>` : ''}<div class="profile-actions"><button id="practice">试玩我的守擂关</button><button id="practice-ai">让宠物试跑</button><span class="fine">试玩不计分 · 不影响正式挑战</span></div>` : `
      <div class="section-heading"><div><span class="eyebrow">YOUR FIRST COMPANION</span><h2>领养你的第一位搭档</h2></div><span class="badge">访客试玩</span></div>
      <form id="adopt"><div class="species-picker"><label><input type="radio" name="species" value="sprout" checked>${avatar('sprout')}<span>芽芽灵</span></label><label><input type="radio" name="species" value="fox">${avatar('fox')}<span>火花狐</span></label><label><input type="radio" name="species" value="ghost">${avatar('ghost')}<span>云朵兽</span></label></div><label for="pet-name">给搭档起个名字</label><div class="input-row"><input id="pet-name" name="name" maxlength="16" required placeholder="例如：会推箱子的栗子"><button class="primary">一起出发 →</button></div><label class="checkbox"><input name="defense" type="checkbox" checked>允许其他宠物直接发起异步挑战（未开始的对局不会判负）</label><p class="fine">身份保存在当前浏览器。清除 Cookie 后无法恢复；此版尚无正式账号系统。</p></form>`;
  }
  const rivals = state.pets.filter(p => p.ready && p.defense);
  $('#rivals').innerHTML = rivals.map(p => `<article class="rival-card">${avatar(p.species)}<span class="badge ${p.bot ? '' : 'ready'}">${p.bot ? '训练宠物 · 不计榜' : '玩家宠物 · 可挑战'}</span><h3>${escape(p.name)}</h3><p>${p.bot ? '先练一场，熟悉人宠应战' : `${p.score} 积分 · ${p.wins} 胜 ${p.losses} 负`}</p><div class="rival-bottom"><span class="ready-text">● 题已备好</span><button data-challenge="${p.id}" ${!mine ? 'disabled' : ''}>挑战它 ↗</button></div></article>`).join('') || '<div class="empty">还没有其他宠物。将页面分享给同一服务器上的另一位玩家。</div>';
  $('#leaderboard').innerHTML = state.leaderboard.length ? state.leaderboard.map((p, i) => `<div class="rank-row ${p.id === mine?.id ? 'is-mine' : ''}"><span class="rank-no">${String(i + 1).padStart(2, '0')}</span>${avatar(p.species, 'tiny')}<div><b>${escape(p.name)}${p.id === mine?.id ? ' <small>你</small>' : ''}</b><small>${p.played} 场 · 计分用时 ${duration(p.rankMs)}</small></div><strong>${p.score}</strong></div>`).join('') : '<div class="empty">第一位上榜的宠物，<br>会是你的搭档吗？</div>';
  $('#matches').innerHTML = state.challenges.length ? state.challenges.map(m => {
    const own = m.sides.find(s => s.own), rival = m.sides.find(s => !s.own);
    const label = m.status === 'void' ? '已作废 · 不计分' : m.status === 'done' ? (m.training ? '训练完成' : !m.winner ? '平局' : m.winner === mine?.id ? '获胜' : '惜败') : status(own.human);
    return `<div class="match-row">${avatar(rival.pet.species, 'tiny')}<div><b>${escape(mine.name)} <span class="muted">vs</span> ${escape(rival.pet.name)}</b><small>${m.training ? '训练赛' : '积分挑战'} · ${label}</small></div><button data-open="${m.id}">${m.status === 'active' && ['pending', 'running'].includes(own.human.status) ? '进入挑战' : '查看结果'}</button></div>`;
  }).join('') : '<div class="empty horizontal">还没有挑战记录。挑一位对手，开始第一场吧。</div>';
  bindHome();
}
function bindHome() {
  bind('#adopt', 'submit', async e => {
    e.preventDefault(); const f = new FormData(e.target), button = e.target.querySelector('button'); button.disabled = true;
    try { await api('/api/pets', { name: f.get('name'), species: f.get('species'), defense: f.get('defense') === 'on' }); document.activeElement?.blur(); await refresh(); notify('搭档已就位！守擂关已备好，选个对手吧。'); }
    catch (err) { notify(err.message, true); button.disabled = false; }
  });
  bind('#prepare', 'submit', async e => {
    e.preventDefault(); const value = new FormData(e.target).get('intent');
    try { await api('/api/pets/prepare', { intent: value }); document.activeElement?.blur(); await refresh(); notify('宠物在后台备题，你可以继续挑战。'); } catch (err) { notify(err.message, true); }
  });
  bind('#practice', 'click', () => openPractice(state.mine.level));
  bind('#practice-ai', 'click', async e => {
    e.currentTarget.disabled = true; notify('宠物正在独立试跑自己的关卡…');
    try { const result = await api('/api/practice/agent', {}); openReplay(result.level, result.actions, `${state.mine.name} · 自测回放`, result.won ? '自测通关，不计分' : '自测未通关，不计分'); }
    catch (err) { notify(err.message, true); } finally { if ($('#practice-ai')) $('#practice-ai').disabled = false; }
  });
  document.querySelectorAll('[data-challenge]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { const m = await api('/api/challenges', { opponentId: button.dataset.challenge }); await openMatch(m.id); await refresh(); }
    catch (err) { notify(err.message, true); button.disabled = false; }
  }));
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openMatch(button.dataset.open).catch(e => notify(e.message, true))));
}
function showDialog() { if (!$('#game-dialog').open) $('#game-dialog').showModal(); }
function storeKey() { return `petrival:replay:${state.mine.id}:${game.id}`; }
async function openMatch(id) {
  let m = await api(`/api/challenges/${id}`);
  const own = m.sides.find(s => s.own);
  if (m.status === 'active' && own.human.status === 'pending') m = await api(`/api/challenges/${id}/start`, {});
  clearInterval(replayTimer);
  game = { kind: 'challenge', id, match: m, level: own.level, actions: '' };
  try { const saved = localStorage.getItem(storeKey()) || ''; replay(game.level.rows, saved); game.actions = saved; } catch { game.actions = ''; }
  $('#game-kind').textContent = m.training ? 'TRAINING · 训练挑战，不计榜' : 'RANKED · 宠物积分挑战';
  $('#game-title').textContent = `挑战 ${m.sides.find(s => !s.own).pet.name} 的守擂关`;
  showDialog(); drawBoard(); renderSide(); updateClock();
  if (m.status === 'active' && m.sides.find(s => s.own).human.status === 'running' && replay(game.level.rows, game.actions).won) await submit(false);
}
function openPractice(level) {
  clearInterval(replayTimer); game = { kind: 'practice', level, actions: '' };
  $('#game-kind').textContent = 'PRACTICE · 自己的守擂关，不计分'; $('#game-title').textContent = `${state.mine.name} 出的题`;
  showDialog(); drawBoard(); renderSide(); updateClock();
}
function openReplay(level, actions, title, note) {
  clearInterval(replayTimer); game = { kind: 'replay', level, actions: '', note };
  $('#game-kind').textContent = 'REPLAY · 真实执行记录'; $('#game-title').textContent = title;
  showDialog(); drawBoard(); renderSide(); updateClock();
  let index = 0;
  replayTimer = setInterval(() => {
    if (!game || game.kind !== 'replay' || index >= actions.length) { clearInterval(replayTimer); return; }
    game.actions += actions[index++]; drawBoard();
  }, RULES.stepMs);
}
function drawBoard() {
  if (!game) return;
  const result = replay(game.level.rows, game.actions), rows = renderRows(result.state);
  $('#board').innerHTML = rows.flatMap(row => [...row]).map((cell, index) => {
    const goal = ['.', '*', '+'].includes(cell), box = ['$', '*'].includes(cell), player = ['@', '+'].includes(cell);
    return `<div class="tile ${cell === '#' ? 'wall' : 'floor'} ${(Math.floor(index / 8) + index % 8) % 2 ? 'alternate' : ''}" aria-label="${cell === '#' ? '墙' : box ? '箱子' : player ? '玩家' : goal ? '目标' : '地面'}">${goal ? '<span class="goal">✿</span>' : ''}${box ? `<span class="crate ${goal ? 'on-goal' : ''}">×</span>` : ''}${player ? avatar(state.mine.species, 'board-pet') : ''}</div>`;
  }).join('');
  $('#steps').textContent = `${result.steps} 步`;
  const locked = game.kind === 'replay' || (game.kind === 'challenge' && (game.match.status !== 'active' || game.match.sides.find(s => s.own).human.status !== 'running'));
  for (const button of document.querySelectorAll('.controls button, .dpad button')) button.disabled = locked || submitting;
  $('#give-up').hidden = game.kind !== 'challenge';
  $('#game-status').textContent = result.won ? '两个箱子都到家了！' : game.kind === 'replay' ? '正在播放宠物的路线' : locked ? '本次挑战已结束' : '把箱子推上花朵';
}
async function act(action) {
  if (!game || submitting || game.kind === 'replay') return;
  if (game.kind === 'challenge' && (game.match.status !== 'active' || game.match.sides.find(s => s.own).human.status !== 'running')) return;
  if (replay(game.level.rows, game.actions).won) {
    if (game.kind !== 'practice' || action !== 'X') return;
    game.actions = '';
  } else game.actions += action;
  try {
    const result = replay(game.level.rows, game.actions);
    if (game.kind === 'challenge') { try { localStorage.setItem(storeKey(), game.actions); } catch { /* storage may be unavailable; server remains authoritative */ } }
    drawBoard();
    if (result.won) {
      if (game.kind === 'challenge') await submit(false);
      else { $('#result-card').innerHTML = '<div class="result success"><h3>试玩通关！</h3><p>这次不计分。准备好就向另一只宠物发起挑战吧。</p></div>'; }
    }
  } catch (e) { game.actions = game.actions.slice(0, -1); notify(e.message, true); }
}
async function submit(giveUp) {
  if (!game || game.kind !== 'challenge' || submitting) return;
  submitting = true; drawBoard();
  try { game.match = await api(`/api/challenges/${game.id}/finish`, { actions: game.actions, giveUp }); renderSide(); await refresh(); }
  catch (e) { notify(`${e.message}。操作已保留，可关闭后重新进入继续提交。`, true); }
  finally { submitting = false; drawBoard(); updateClock(); }
}
function renderSide() {
  if (!game) return;
  if (game.kind !== 'challenge') {
    $('#agent-card').innerHTML = `<div class="agent-heading">${avatar(state.mine.species)}<div><h3>${escape(state.mine.name)}</h3><p>${game.kind === 'replay' ? escape(game.note) : '自己的关卡，放心练习'}</p></div></div>`;
    $('#result-card').innerHTML = `<div class="result"><b>${game.kind === 'replay' ? '回放仅展示已执行的操作' : '这张关卡已通过可解性验证'}</b><p>${game.kind === 'replay' ? '算法搜索与大模型模式均明确标注，不使用出题证明代替参赛操作。' : '自己试玩不计排名。可以撤销、重来，也可以从主页让宠物试跑。'}</p></div>`;
    return;
  }
  const m = game.match, own = m.sides.find(s => s.own);
  $('#agent-card').innerHTML = m.sides.map(s => `<div class="agent-block"><div class="agent-heading">${avatar(s.pet.species, 'small-pet')}<div><h3>${escape(s.pet.name)}${s.own ? ' · 你的搭档' : ''}</h3><p>${method(s.agent.method || state.mode)}</p></div></div><div class="run-line"><span>宠物</span><b>${status(s.agent)} ${s.agent.score === null ? '' : `${s.agent.score > 0 ? '+' : ''}${s.agent.score}`}</b></div><div class="run-line"><span>主人</span><b>${status(s.human)} ${s.human.score == null ? '' : `${s.human.score > 0 ? '+' : ''}${s.human.score}`}</b></div>${s.agent.actions ? `<button data-replay="${s.pet.id}" class="wide">观看宠物回放 ▶</button>` : '<p class="fine">你结束挑战后显示宠物路线。</p>'}</div>`).join('');
  $('#agent-card').querySelectorAll('[data-replay]').forEach(button => button.addEventListener('click', () => {
    const s = m.sides.find(s => s.pet.id === button.dataset.replay);
    openReplay(s.level, s.agent.actions, `${s.pet.name} · 挑战回放`, `${method(s.agent.method)} · ${status(s.agent)} · ${s.agent.steps || 0} 步`);
  }));
  if (m.status === 'void') $('#result-card').innerHTML = `<div class="result"><h3>本场不计分</h3><p>${escape(m.voidReason)}</p></div>`;
  else if (m.status === 'done') {
    const title = m.training ? '训练完成！' : !m.winner ? '势均力敌，平局！' : m.winner === own.pet.id ? '搭档，拿下了！' : '这次惜败，下次再战';
    $('#result-card').innerHTML = `<div class="result ${m.training || m.winner === own.pet.id ? 'success' : ''}"><h3>${title}</h3><strong>${own.total.score > 0 ? '+' : ''}${own.total.score}</strong><p>${m.training ? '训练分不进入排行榜。' : '人宠合计分已计入宠物排行榜。'}计分用时 ${duration(own.total.rankMs)}</p></div>`;
  } else $('#result-card').innerHTML = `<div class="result"><b>${['cleared', 'failed'].includes(own.human.status) ? '你的挑战已提交' : '本场关卡版本已锁定'}</b><p>${['cleared', 'failed'].includes(own.human.status) ? '等待宠物和对方主人完成后统一结算。你可以关闭窗口，稍后回来查看。' : '后台换题不会修改本场。真人结束后才能查看宠物路线。'}</p></div>`;
  drawBoard();
}
function updateClock() {
  if (!game) return;
  const run = game.kind === 'challenge' ? game.match.sides.find(s => s.own).human : null;
  $('#clock').textContent = !run ? '不限时' : run.status === 'running' ? duration(run.deadline - Date.now() - clockOffset) : duration(run.elapsedMs || 0);
  if (run?.status === 'running' && run.deadline <= Date.now() + clockOffset) { $('#game-status').textContent = '时间到，等待服务端结算'; }
}
$('#refresh').addEventListener('click', refresh);
$('#close-game').addEventListener('click', () => { $('#game-dialog').close(); clearInterval(replayTimer); game = null; });
$('#game-dialog').addEventListener('cancel', () => { clearInterval(replayTimer); game = null; });
$('#undo').addEventListener('click', () => act('Z'));
$('#restart').addEventListener('click', () => act('X'));
$('#give-up').addEventListener('click', () => { if (confirm('认输将记录 −20 分，宠物仍会继续挑战。确定吗？')) submit(true); });
document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => act(button.dataset.dir)));
document.addEventListener('keydown', event => {
  if (!$('#game-dialog').open || event.ctrlKey || event.metaKey || ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  const key = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', w: 'U', s: 'D', a: 'L', d: 'R', z: 'Z', r: 'X' }[event.key];
  if (key) { event.preventDefault(); act(key); }
});
setInterval(updateClock, 250);
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
try { await api('/api/session', {}); await refresh(); }
catch (e) { $('#my-pet').innerHTML = '<div class="empty">连接失败，请刷新页面重试。</div>'; notify(e.message, true); }
