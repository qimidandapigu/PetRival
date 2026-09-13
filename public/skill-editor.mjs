export function openSkillEditor(pet, { api, refresh, notify }) {
  document.querySelector('#competition-skill-dialog')?.remove();
  const competition = pet.competition, equipped = competition.equipped;
  const dialog = document.createElement('dialog'); dialog.id = 'competition-skill-dialog';
  dialog.className = 'competition-skill-dialog';
  dialog.innerHTML = `<form id="competition-skill-form">
    <div class="dialog-top"><div><span class="eyebrow">COMPETITION SKILL</span><h2>比赛技能槽</h2></div><button type="button" id="skill-close" aria-label="关闭技能编辑">×</button></div>
    <p class="skill-intro">技巧 100 · 一个技能槽。描述和 TS 代码共用容量，执行技能不消耗容量。保存后用于新比赛。</p>
    <label for="skill-name">技能名称</label><input id="skill-name" maxlength="24" required placeholder="例如：优先归位">
    <label for="skill-game">比赛项目</label><select id="skill-game"><option value="sokoban">推箱子</option><option value="boxing">打拳</option></select>
    <label for="skill-description">技能描述</label><textarea id="skill-description" rows="2" maxlength="4096" required placeholder="什么情况下使用，做什么？"></textarea>
    <label for="skill-code">TS 代码</label><textarea id="skill-code" rows="6" maxlength="4096" required spellcheck="false" autocapitalize="off"></textarea>
    <div class="skill-capacity-row"><strong>技能容量</strong><output id="skill-token-count" aria-live="polite">正在统计…</output></div>
    <progress id="skill-capacity-meter" max="100" value="0" aria-label="技能容量占用"></progress>
    <p id="skill-validation" role="status"></p>
    <details class="skill-help"><summary>写法与可用局面</summary><p>返回 availablePushes 中的 id，或 undo、restart。返回 null 时继续原有决策。支持 const、if、条件表达式、数组 find/filter/some/every/includes；不支持循环、联网和任意函数调用。</p><pre>SkillContext {
  availablePushes: {
    id: string; onGoal: boolean;
    wasOnGoal: boolean; corner: boolean;
    direction: string; walkSteps: number;
    box: { x: number; y: number };
    boxTo: { x: number; y: number };
  }[];
  canUndo: boolean; turn: number;
  visitsToThisPosition: number;
  remainingSeconds: number;
}</pre><p>打拳局面提供 distance、secondsLeft、self / opponent（hp、maxHp、power、action、attackAge、stunned）。返回 advance、retreat、jab、heavy、guard、idle 中的一个动作，或 null。技能只作用于宠物控制的拳手。</p><p>固定使用 o200k_base 分词器，分别计算原样保存的描述和代码后相加。空格、注释、类型标注均计入；名称不占 token 容量，最多 24 个字。一个槽位同时只能装备一个项目的技能。</p></details>
    <div class="skill-editor-actions"><button type="button" id="skill-example">填入示例</button><button type="button" id="skill-clear">卸下技能</button><button type="submit" id="skill-save" class="primary" disabled>保存技能</button></div>
  </form>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  $('#skill-name').value = equipped?.name || '';
  $('#skill-game').value = equipped?.gameId || 'sokoban';
  $('#skill-example').textContent = equipped?.gameId === 'boxing' ? '填入打拳示例' : '填入推箱子示例';
  $('#skill-description').value = equipped?.description || '';
  $('#skill-code').value = equipped?.code || '(ctx: SkillContext) => null';
  $('#skill-clear').hidden = !equipped;
  let serial = 0, timer, saving = false, checked = null;
  const input = () => ({ gameId: $('#skill-game').value, name: $('#skill-name').value, description: $('#skill-description').value, code: $('#skill-code').value });
  function pending() {
    serial++; checked = null; clearTimeout(timer); $('#skill-save').disabled = true;
    $('#skill-token-count').textContent = '正在统计…';
    $('#skill-validation').textContent = '正在校验描述、代码和当前守擂关…';
    timer = setTimeout(validate, 350);
  }
  async function validate() {
    const ticket = serial, body = input();
    try {
      const result = await api('/api/pets/skill/check', body);
      if (!dialog.isConnected || ticket !== serial) return;
      checked = result.valid ? JSON.stringify(body) : null;
      $('#skill-token-count').textContent = `${result.tokens ?? '—'} / 100 token`;
      $('#skill-capacity-meter').value = Math.min(100, result.tokens || 0);
      $('#skill-validation').textContent = result.valid ? `校验通过 · 当前守擂关试运行：${result.preview?.message || '通过'}` : result.error;
      $('#skill-validation').classList.toggle('error-text', !result.valid);
      $('#skill-save').disabled = saving || !result.valid;
    } catch (error) {
      if (ticket !== serial || !dialog.isConnected) return;
      $('#skill-token-count').textContent = '暂未取得计数';
      $('#skill-validation').textContent = `${error.message}。继续编辑可重新校验。`;
    }
  }
  async function save(skill) {
    if (saving) return; saving = true; serial++; clearTimeout(timer);
    dialog.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = true; });
    $('#skill-validation').textContent = '正在保存…';
    try {
      await api('/api/pets/skill', { revision: competition.revision, skill });
      dialog.close(); await refresh(); notify(skill ? '比赛技能已保存，下场比赛生效。' : '技能已卸下，下场比赛使用原有决策。');
    } catch (error) {
      saving = false;
      dialog.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = false; });
      $('#skill-save').disabled = true; checked = null;
      $('#skill-validation').textContent = error.message;
    }
  }
  $('#competition-skill-form').addEventListener('submit', event => {
    event.preventDefault(); const body = input();
    if (checked === JSON.stringify(body)) save(body); else pending();
  });
  for (const el of dialog.querySelectorAll('input, textarea')) el.addEventListener('input', pending);
  $('#skill-game').addEventListener('change', () => {
    $('#skill-example').textContent = $('#skill-game').value === 'boxing' ? '填入打拳示例' : '填入推箱子示例'; pending();
  });
  $('#skill-example').addEventListener('click', () => {
    if ($('#skill-game').value === 'boxing') {
      $('#skill-name').value = '近身快拳';
      $('#skill-description').value = '远处接近，对手重拳时后撤，否则近身出刺拳。';
      $('#skill-code').value = '(ctx: SkillContext) =>\n  ctx.distance > 114 ? "advance" : ctx.opponent.action === "heavy" ? "retreat" : "jab"';
      pending(); return;
    }
    $('#skill-name').value = '优先归位';
    $('#skill-description').value = '优先将未归位的箱子推入目标，避开死角。';
    $('#skill-code').value = '(ctx: SkillContext) =>\n  ctx.availablePushes.find(p => p.onGoal && !p.wasOnGoal && !p.corner)?.id ?? null';
    pending();
  });
  $('#skill-close').addEventListener('click', () => dialog.close());
  $('#skill-clear').addEventListener('click', () => save(null));
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { serial++; clearTimeout(timer); dialog.remove(); });
  dialog.showModal(); pending();
}
