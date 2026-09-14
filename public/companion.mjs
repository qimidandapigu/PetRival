import { petDisplayName } from '/shared/pet.mjs';
import { petMarkup } from '/shared/pet.mjs'; import { createWorldScene } from '/world-scene.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createCompanionHub({ api, notify, refresh, onPlay, onEditPet }) {
  const root = document.querySelector('#companion-hub');
  const $ = selector => root.querySelector(selector);
  let state, petId, messages = [], busy = false, loading = false, failedRequest = null, skillsKey = '', profileKey = '', serverClockOffset = 0, latestClock = 0;
  root.innerHTML = `
    <section class="panel pet-world" id="pet-world" aria-label="宠物生活的小院">
      <div class="world-heading"><div><span class="world-leaf" aria-hidden="true">✦</span><div><h2>晴风小院</h2><p>一间小屋，一段属于你们的日常</p></div></div><span id="world-time" class="world-time">小院正在醒来</span></div>
      <div class="world-stage"><canvas id="world-canvas" width="768" height="512" role="img" aria-label="像素田园：宠物在小屋、菜地、野餐区和池塘之间自主生活，可以在旁边和它聊天。"></canvas><div class="world-location-label"><span class="world-live-dot"></span><span id="world-live-state">等待搭档入住</span></div><div id="world-speech" class="world-speech" hidden></div><button type="button" id="world-chat-focus" class="world-chat-focus" aria-label="和正在小院里的宠物聊天">和它说句话 ↗</button></div>
      <div class="world-pet-bar"><span id="world-avatar"></span><div class="world-pet-name"><b id="world-pet-name">你的小伙伴</b><span id="world-activity">领养后，小院就有了主人</span><button type="button" id="world-edit-pet">换外观</button></div><div class="world-vitals"><label><span>活力 <b id="energy-value">—</b></span><progress id="energy-meter" max="100" value="0" aria-label="宠物活力"></progress></label><label><span>饱腹 <b id="satiety-value">—</b></span><progress id="satiety-meter" max="100" value="0" aria-label="宠物饱腹"></progress></label><label><span>心情 <b id="mood-value">—</b></span><progress id="mood-meter" max="100" value="0" aria-label="宠物心情"></progress></label></div></div>
      <p class="world-companionship">它有自己的日常，也会把你的话放在心上。</p>
      <div class="world-footer"><span id="world-recent">小院里的一天，正慢慢展开。</span><span id="world-crops">小小菜地，慢慢生长</span></div>
    </section>
    <section class="panel pet-chat" id="pet-chat" aria-label="和宠物对话">
      <div class="chat-heading"><div class="chat-identity"><span id="chat-avatar"></span><div><span class="eyebrow">LIFE IS BETTER WITH YOU</span><h2 id="chat-title">和你的搭档聊聊</h2><span id="chat-presence" class="chat-presence">领养后开启对话</span></div></div><span id="chat-mode" class="badge"></span></div>
      <div id="chat-log" class="chat-log" role="log" aria-label="对话记录" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>
      <div class="chat-compose">
        <div class="chat-prompts" aria-label="快捷话题"><button type="button" data-prompt="你在小院里做什么呀？">你在做什么</button><button type="button" data-prompt="今天在小院过得怎么样？累不累？">聊聊今天</button><button type="button" data-prompt="你现在几级了？学会了哪些技能？">看看你的成长</button></div>
        <div id="chat-feedback" class="chat-feedback" role="status" hidden></div>
        <form id="chat-form"><label class="sr-only" for="chat-input">想对宠物说的话</label><div class="chat-input-row"><textarea id="chat-input" name="message" rows="2" maxlength="1000" placeholder="它就在小院里，和它说说话…" required></textarea><button class="primary" id="chat-send" type="submit" aria-label="发送消息">发送 ↑</button></div><div class="compose-foot"><span id="chat-help">Enter 发送 · Shift + Enter 换行</span><span id="chat-counter">0 / 1000</span></div></form>
      </div>
    </section>
    <section class="panel game-library" id="game-library" aria-label="选择游戏">
      <div class="section-heading"><div><span class="eyebrow">A LITTLE ADVENTURE</span><h2>游戏小屋</h2></div><span class="game-count">02</span></div>
      <button type="button" class="game-choice" id="choose-sokoban" aria-pressed="true">
        <span class="game-art" aria-hidden="true"><span class="mini-goal g-one">✿</span><span class="mini-goal g-two">✿</span><span class="mini-box b-one">×</span><span class="mini-box b-two">×</span><span id="game-pet-art"></span></span>
        <span class="game-choice-info"><span><strong>推箱子</strong><small>益智解谜 · 人宠同玩</small></span><span class="selected-check" id="sokoban-selected">✓ 已选择</span></span>
      </button>
      <button type="button" class="game-choice" id="choose-boxing" aria-pressed="false"><span class="game-choice-info"><span><strong>打拳</strong><small>宠物对战 · 真人同时应战</small></span><span class="selected-check" id="boxing-selected">选择 ↗</span></span></button>
      <p class="game-description" id="game-description">生活之余，和搭档来一场推箱子。</p>
      <button type="button" id="hub-play" class="primary">进入推箱子 <span>↗</span></button>
      <a class="rival-link" href="#rival-section">去挑选一位对手 →</a>
      <div class="coming-games"><span>＋</span><div>小院之外，也有小小冒险<small>共用宠物与存档，两种游戏分别排名</small></div></div>
    </section>
    `;

  $('#world-edit-pet').addEventListener('click', () => { if (state?.mine) onEditPet?.(); });
  const scene = createWorldScene($('#world-canvas'), { onInteract: action => {
    if (action === 'chat') { $('#chat-input').focus(); return; }
    if (action === 'game') { $('#game-library').scrollIntoView({ behavior: 'smooth' }); $('#hub-play').focus({ preventScroll: true }); return; }
  } });
  function renderLife(life) {
    scene.update({ pet: state?.mine || null, life, now: Date.now() + serverClockOffset });
    $('#world-pet-name').textContent = state?.mine ? `${petDisplayName(state.mine.name)} · Lv.${state.mine.progression?.level || 1}` : '等一位小伙伴入住';
    const when = { morning: '清晨', day: '午后', evening: '傍晚', night: '夜晚' };
    $('#world-time').textContent = life ? `第 ${life.day} 天 · ${when[life.timeOfDay] || '晴日'}` : '晴风小院';
    $('#world-activity').textContent = life ? `${life.location.name} · ${life.activityLabel}` : '领养后，小院就有了主人';
    $('#world-live-state').textContent = life ? `${petDisplayName(state.mine.name)} · ${life.activityLabel}` : '小院展示 · 等待入住';
    for (const [key, value] of [['energy', life?.energy], ['satiety', life ? 100 - life.hunger : undefined], ['mood', life?.mood]]) {
      $(`#${key}-value`).textContent = value === undefined ? '—' : Math.round(value);
      $(`#${key}-meter`).value = value || 0;
    }
    const events = life?.events || [];
    const recent = events.length ? events.reduce((latest, item) => item.at > latest.at ? item : latest, events[0]) : null;
    $('#world-recent').textContent = recent?.text || '小院里的一天，正慢慢展开。';
    $('#world-crops').textContent = life ? `菜地生长 ${Math.round(life.crops.growth)}% · 已收获 ${life.crops.harvests} 次` : '小小菜地，慢慢生长';
    $('#chat-presence').textContent = life ? `● ${life.location.name} · ${life.activityLabel}` : '领养后开启对话';
  }
  $('#world-chat-focus').addEventListener('click', () => {
    if (!state?.mine) { document.querySelector('#my-pet').scrollIntoView({ behavior: 'smooth' }); return; }
    $('#chat-input').focus();
  });
  function acceptLife(life) {
    if (!life || !state?.mine) return;
    if (!state.mine.life || (life.revision ?? 0) >= (state.mine.life.revision ?? 0)) state.mine.life = life;
  }

  function feedback(text, retry = false) {
    const node = $('#chat-feedback'); node.hidden = !text;
    node.replaceChildren(document.createTextNode(text));
    if (retry) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', () => send(failedRequest.message)); node.append(button);
    }
  }
  function controls() {
    $('#world-edit-pet').hidden = !state?.mine;
    $('#chat-input').disabled = !state?.mine || busy || loading;
    $('#chat-send').disabled = !state?.mine || busy || loading || !$('#chat-input').value.trim();
    $('#chat-send').textContent = busy ? '回复中…' : '发送 ↑';
    root.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = !state?.mine || busy || loading; });
    $('#chat-counter').textContent = `${$('#chat-input').value.length} / 1000`;
    $('#chat-log').setAttribute('aria-busy', String(busy || loading));
    $('#world-speech').hidden = !busy;
    if (busy) $('#world-speech').textContent = '听到啦，让我想想怎么说…';
  }
  function drawMessages(pendingText) {
    const log = $('#chat-log'), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = messages.length ? messages.map(m => `<div class="chat-message ${m.role === 'user' ? 'from-user' : 'from-pet'}"><span class="message-author">${m.role === 'user' ? '你' : escape(petDisplayName(state.mine?.name))}${m.role === 'assistant' ? `<small>${m.method === 'model' ? escape(m.model || 'AI 对话') : '本地规则回复'}</small>` : ''}</span><div class="message-bubble">${escape(m.content)}</div></div>`).join('') : `<div class="chat-welcome"><span class="welcome-spark">✦</span><h3>${state?.mine ? '风吹过小院，它也在等你' : '先认识你的第一位搭档'}</h3><p>${state?.mine ? '左边是它正在生活的小世界。<br>在这里，聊聊日常，也聊聊你。' : '领养一只宠物，让它住进这座小院。<br>一起散步、照料菜地、玩游戏。'}</p>${state?.mine ? '' : '<a href="#my-pet">去领养宠物 →</a>'}</div>`;
    if (pendingText && messages.at(-1)?.content !== pendingText) log.insertAdjacentHTML('beforeend', `<div class="chat-message from-user"><span class="message-author">你</span><div class="message-bubble">${escape(pendingText)}</div></div>`);
    if (busy) log.insertAdjacentHTML('beforeend', `<div class="chat-thinking">${escape(petDisplayName(state.mine.name))} 正在想怎么回复你<span> · · ·</span></div>`);
    if (nearBottom || pendingText) log.scrollTop = log.scrollHeight;
  }
  async function loadHistory() {
    if (!state?.mine || busy) return;
    const currentPet = state.mine.id; loading = true; controls();
    try { const result = await api('/api/pets/chat'); if (state.mine?.id === currentPet) { messages = result.messages; drawMessages(); feedback(''); if (result.pending) setTimeout(() => { if (state.mine?.id === currentPet) loadHistory(); }, 1500); } }
    catch (err) { feedback(`对话记录暂时没加载成功：${err.message}`); }
    finally { loading = false; controls(); }
  }
  async function send(text) {
    text = text.trim(); if (!state?.mine || !text || busy || loading) return;
    if (text.length > 1000) return;
    const request = failedRequest?.message === text ? failedRequest : { message: text, requestId: crypto.randomUUID() };
    busy = true; feedback(''); controls(); drawMessages(text);
    try {
      let result = await api('/api/pets/chat', request);
      const started = Date.now();
      while (result.request?.status === 'pending') {
        if (Date.now() - started > 180000) throw new Error('回复仍在排队或处理中，请稍后重试');
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = await api('/api/pets/chat?requestId=' + encodeURIComponent(request.requestId));
      }
      if (result.request?.status === 'failed') throw new Error(result.request.error || '宠物暂时无法回复');
      messages = result.messages; failedRequest = null;
      if (result.life) { acceptLife(result.life); renderLife(state.mine.life); }
      if ($('#chat-input').value.trim() === text) $('#chat-input').value = '';
    } catch (err) {
      failedRequest = request; feedback(`这次没收到回复：${err.message}。消息已保留。`, true);
      // Read the server's saved user turn so a retry never draws it twice.
      try { messages = (await api('/api/pets/chat')).messages; } catch { /* Keep the draft available. */ }
    } finally {
      busy = false; controls(); drawMessages(failedRequest ? text : undefined);
      $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
      if (document.activeElement === document.body || $('#pet-chat').contains(document.activeElement)) $('#chat-input').focus({ preventScroll: true });
    }
  }
  $('#chat-form').addEventListener('submit', event => { event.preventDefault(); send($('#chat-input').value); });
  $('#chat-input').addEventListener('input', controls);
  $('#chat-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); send(event.currentTarget.value); }
  });
  root.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('#chat-input').value = button.dataset.prompt; controls(); $('#chat-input').focus(); }));
  $('#choose-sokoban').addEventListener('click', async () => {
    if (!state.mine) { notify('推箱子已选好，先领养一位搭档吧。'); document.querySelector('#my-pet').scrollIntoView({ behavior: 'smooth' }); return; }
    try { await api('/api/pets/game', { gameId: 'sokoban' }); await refresh(); notify('已选择推箱子，和搭档一起出发吧。'); } catch (err) { notify(err.message, true); }
  });
  $('#choose-boxing').addEventListener('click', async () => {
    if (!state.mine) { notify('先领养一位搭档，再一起打拳吧。'); document.querySelector('#my-pet').scrollIntoView({ behavior: 'smooth' }); return; }
    try { await api('/api/pets/game', { gameId: 'boxing' }); await refresh(); notify('已选择打拳，下面选择一位对手。'); } catch (err) { notify(err.message, true); }
  });
  $('#hub-play').addEventListener('click', async () => {
    if (!state.mine) { document.querySelector('#my-pet').scrollIntoView({ behavior: 'smooth' }); document.querySelector('#pet-name')?.focus({ preventScroll: true }); return; }
    $('#hub-play').disabled = true;
    try { await onPlay(); } finally { $('#hub-play').disabled = false; }
  });

  return { update(nextState) {
    const olderLife = state?.mine?.id === nextState.mine?.id && state?.mine?.life && (state.mine.life.revision ?? 0) > (nextState.mine.life?.revision ?? 0);
    if (olderLife) {
      nextState = { ...nextState, mine: { ...nextState.mine, life: state.mine.life } };
    }
    if (!olderLife && Number.isFinite(nextState.now) && nextState.now >= latestClock) { latestClock = nextState.now; serverClockOffset = nextState.now - Date.now(); }
    state = nextState; const mine = state.mine;
    const nextProfile = JSON.stringify([mine?.id, mine?.name, mine?.species, mine?.appearance]);
    if (profileKey !== nextProfile) {
      profileKey = nextProfile;
      $('#chat-avatar').innerHTML = petMarkup(mine || { species: 'xiaotangyuan' });
      $('#game-pet-art').innerHTML = petMarkup(mine || { species: 'xiaotangyuan' });
      $('#world-avatar').innerHTML = petMarkup(mine || { species: 'xiaotangyuan' });
      $('#chat-title').textContent = mine ? `和${petDisplayName(mine.name)}聊聊` : '和你的搭档聊聊';
    }
    $('#chat-mode').textContent = state.mode === 'model' ? (state.model === 'deepseek-v4-pro' ? 'DeepSeek Pro' : state.model || 'AI 对话') : '本地规则对话';
    renderLife(mine?.life);
    const boxing = mine?.selectedGame === 'boxing';
    $('#choose-sokoban').setAttribute('aria-pressed', String(!boxing));
    $('#choose-boxing').setAttribute('aria-pressed', String(boxing));
    $('#sokoban-selected').textContent = boxing ? '选择 ↗' : '✓ 已选择';
    $('#boxing-selected').textContent = boxing ? '✓ 已选择' : '选择 ↗';
    $('#game-description').textContent = boxing ? '左边宠物对打，右边你也上场。拳台积分单独排名。' : '生活之余，和搭档来一场推箱子。';
    $('#hub-play').innerHTML = mine ? (boxing ? '选择打拳对手 <span>↗</span>' : '进入推箱子 <span>↗</span>') : '先领养宠物 <span>↗</span>';
    $('#chat-help').textContent = state.mode === 'model' ? 'Enter 发送 · 对话会发送给当前模型服务' : 'Enter 发送 · Shift + Enter 换行 · 本地规则回复';
    if (petId !== mine?.id) { petId = mine?.id; messages = []; failedRequest = null; drawMessages(); if (mine) loadHistory(); }
    else if (!mine) drawMessages();
    controls();
    const growth = mine?.progression;
    const nextSkills = JSON.stringify([mine?.id, growth, mine?.competition]);
    if (nextSkills !== skillsKey) {
      skillsKey = nextSkills;
      const skills = growth?.skills || [], unlocked = skills.filter(s => s.unlocked).length;
      const panel = document.querySelector('#pet-skills');
      const competition = mine?.competition, equipped = competition?.equipped;
      const openSkills = [...panel.querySelectorAll('details[open]')].map(d => d.dataset.skill);
      panel.innerHTML = `<div class="section-heading"><div><span class="eyebrow">LITTLE STEPS, REAL GROWTH</span><h2>宠物技能库</h2></div><span class="skill-count">${unlocked}<small> / ${skills.length}</small></span></div>
        ${competition ? `<section class="competition-slot" aria-label="比赛技能"><h3>技巧 · ${competition.capacity}</h3><div class="skill-capacity-row"><strong>${escape(equipped?.name || '空技能槽')}</strong><span>${equipped ? 1 : 0} / 1 槽</span></div><p>技能容量 ${equipped?.tokens || 0} / ${competition.capacity} token · ${equipped?.gameId === 'boxing' ? '打拳' : equipped ? '推箱子' : '推箱子 / 打拳'}</p><progress max="${competition.capacity}" value="${equipped?.tokens || 0}" aria-label="比赛技能容量"></progress><p>${escape(equipped?.description || '保留一段比赛策略，读取当前局面并选择动作。')}</p><button id="edit-competition-skill" type="button">${equipped ? '查看 / 替换技能' : '装备比赛技能'}</button></section>` : ''}
        ${mine ? `<div class="growth-summary"><span class="level-emblem">Lv.<b>${growth?.level || 1}</b></span><div><b>${growth?.clears || 0} 张新地图已通关</b><span>再获 ${Math.max(0, (growth?.xpForNextLevel || 100) - (growth?.xpIntoLevel || 0))} 经验升到下一级</span></div></div><progress class="xp-progress" max="${growth?.xpForNextLevel || 100}" value="${growth?.xpIntoLevel || 0}" aria-label="宠物升级经验"></progress><div class="xp-caption"><span>成长经验</span><b>${growth?.xpIntoLevel || 0} / ${growth?.xpForNextLevel || 100} XP</b></div>
        <div class="skill-list">${skills.map((s, index) => `<details class="skill-item ${s.unlocked ? 'unlocked' : 'locked'}" data-skill="${escape(s.id)}" ${openSkills.includes(s.id) ? 'open' : ''}><summary><span class="skill-icon">${s.unlocked ? '✦' : '◇'}</span><span><b>${escape(s.name)}</b><small>${s.unlocked ? '已解锁 · 推箱子' : escape(s.requirement)}</small></span><span class="skill-chevron">${s.unlocked ? '✓' : String(index + 1).padStart(2, '0')}</span></summary><p>${escape(s.description)}</p><div class="skill-condition">${escape(s.requirement)}${s.learnedAt ? `<br>解锁于 ${new Date(s.learnedAt).toLocaleDateString('zh-CN')}` : ''}</div></details>`).join('')}</div><p class="growth-rule">宠物首次通关新地图 +40 XP。技能库先记录闯关里程碑，聊天不会增加经验。</p>` : '<div class="empty">领养后，从 Lv.1 开始。<br>带宠物闯关，点亮第一项技能。</div>'}`;
    }
  } };
}
