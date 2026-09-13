import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Arena, ApiError } from '../server/arena.mjs';
import { replay, RULES, runScore } from '../shared/game.mjs';
import { recordVerifiedClear, progressionView } from '../shared/progression.mjs';
import { LIFE_ACTIONS, advanceLife, requestLifeAction, lifeView } from '../shared/life.mjs';
import { stateKey } from '../server/step-observation.mjs';

const requireThat = (ok, message, status = 400) => { if (!ok) throw new ApiError(status, message); };
const pending = () => ({ status: 'pending', actions: '', score: null });
const publicRun = run => Object.fromEntries(Object.entries(run).filter(([key]) => !key.startsWith('_')));
export class CloudArena extends Arena {
  constructor(store, brain, options = {}) {
    super(store, brain, { ...options, recover: false });
    this.practices = new Map(Object.values(this.s.practices).map(p => [p.owner, p]));
  }
  task(fn) { return fn(); }
  chatView(owner, requestId) {
    const result = super.chatView(owner), pet = this.mine(owner);
    const receipt = pet.chat.requests.find(r => r.id === requestId);
    return { ...result, pending: pet.chat.requests.some(r => r.status === 'pending'),
      ...(receipt ? { request: { id: receipt.id, status: receipt.status, error: receipt.error } } : {}) };
  }
  chat(owner, input) {
    const pet = this.mine(owner); requireThat(pet, '请先领养宠物', 409);
    requireThat(typeof input.message === 'string' && input.message.trim() && input.message.length <= 1000, '请输入 1–1000 字的消息', 422);
    requireThat(input.requestId === undefined || (typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)), '消息标识无效', 422);
    const message = input.message.trim(), id = input.requestId || randomUUID(), messageHash = createHash('sha256').update(message).digest('hex');
    let receipt = pet.chat.requests.find(r => r.id === id);
    if (receipt) {
      requireThat(receipt.messageHash === messageHash, '消息标识已用于另一条消息', 409);
      if (receipt.status !== 'failed') return this.chatView(owner, id);
    }
    requireThat(pet.chat.requests.filter(r => r.status === 'pending').length < 5, '宠物正在回复，请稍后再发', 429);
    if (!receipt) {
      receipt = { id, messageHash, userId: randomUUID(), status: 'pending' };
      pet.chat.requests.push(receipt);
      pet.chat.messages.push({ id: receipt.userId, role: 'user', content: message, createdAt: this.now() });
      pet.chat.messages = pet.chat.messages.slice(-60);
    }
    receipt.status = 'pending'; delete receipt.error;
    this.enqueue('chat', `${pet.id}:${id}`, { petId: pet.id, requestId: id, message });
    return this.chatView(owner, id);
  }
  enqueue(kind, target, extra = {}) {
    const id = `${kind}:${target}`;
    if (this.s.jobs[id] && ['pending', 'running'].includes(this.s.jobs[id].status)) return;
    this.s.jobs[id] = { id, kind, target, ...extra, status: 'pending', createdAt: this.now() };
  }
  prepare(pet, intent) {
    if (pet.preparing) return;
    if (intent !== undefined) pet.intent = typeof intent === 'string' ? intent.trim().slice(0, 240) || pet.intent : pet.intent;
    pet.preparing = true; pet.prepareError = null;
    this.enqueue('generate', pet.id, { intent: pet.intent, seed: randomBytes(4).readUInt32LE() });
  }
  launchAgents(match) {
    if (match.status !== 'active') return;
    for (const side of match.sides) if (side.agent.status === 'pending') this.enqueue('play', `${match.id}:${side.petId}`, { matchId: match.id, petId: side.petId, levelId: side.levelId });
  }
  matchView(match, owner) {
    const view = super.matchView(match, owner);
    for (const side of view.sides) side.agent = publicRun(side.agent);
    return view;
  }
  practiceView(p) { return { id: p.id, level: p.level, run: publicRun(p.run), ranked: false }; }
  getPractice(owner, id) { this.tick(); return super.getPractice(owner, id); }
  startPractice(owner, { style = this.brain.playEffort === 'none' ? 'push' : 'plan' } = {}) {
    requireThat(['plan', 'step', 'push'].includes(style), '未知试玩方式');
    const pet = this.mine(owner); requireThat(pet, '请先领养宠物');
    this.tick();
    const previous = this.practices.get(owner);
    if (previous && ['running', 'pending'].includes(previous.run.status)) return this.practiceView(previous);
    if (previous) delete this.s.practices[previous.id];
    const p = { id: randomUUID(), owner, petId: pet.id, level: this.levelView(pet.readyId), createdAt: this.now(),
      run: { ...pending(), status: 'running', startedAt: this.now(), deadline: this.now() + RULES.limitMs, method: this.brain.mode, model: this.brain.info().model, playStyle: this.brain.mode === 'model' ? style : 'plan', effort: this.brain.info().playEffort, note: '宠物正在准备路线，你可以同时开始' } };
    this.s.practices[p.id] = p; this.practices.set(owner, p);
    this.enqueue('play', `practice:${p.id}`, { practiceId: p.id, petId: pet.id, levelId: pet.readyId });
    return this.practiceView(p);
  }
  targetRun(job) {
    if (job.practiceId) return this.s.practices[job.practiceId]?.run;
    return this.s.challenges[job.matchId]?.sides.find(s => s.petId === job.petId)?.agent;
  }
  settle(match) {
    const previous = match.status;
    const originalNow = this.now;
    const runs = match.sides.flatMap(side => [side.human, side.agent]).filter(run => run.status !== 'not_applicable');
    if (runs.every(run => ['cleared', 'failed'].includes(run.status))) this.now = () => Math.max(...runs.map(run => run.finishedAt || run.startedAt + run.elapsedMs));
    try { super.settle(match); } finally { this.now = originalNow; }
    if (previous !== 'active' || match.status !== 'done' || match.training) return;
    for (const side of match.sides) {
      const pet = this.s.pets[side.petId];
      this.store.ledger.push({ id: `${match.id}:${pet.id}`, matchId: match.id, petId: pet.id, petName: pet.name, delta: side.total.score, total: pet.score, rankMs: side.total.rankMs, outcome: !match.winner ? 'draw' : match.winner === pet.id ? 'win' : 'loss', createdAt: match.finishedAt });
    }
  }
  completeRun(run, level, pet, success, at, note) {
    const elapsedMs = Math.max(1, at - run.startedAt);
    success = success && elapsedMs <= RULES.limitMs;
    Object.assign(run, { status: success ? 'cleared' : 'failed', elapsedMs, finishedAt: at, note, ...runScore(success, elapsedMs) });
    delete run._plan;
    if (success) recordVerifiedClear(pet, level.hash, at);
  }
  advance(run, level, pet, target) {
    if (run.status !== 'running' || !run._plan) return;
    const until = Math.min(this.now(), run.deadline), count = Math.min(run._plan.actions.length, Math.max(0, Math.floor((until - run._plan.at) / RULES.stepMs)));
    let prefix = run.actions || run._plan.prefix, result = replay(level.rows, prefix), executedCount = prefix.length - run._plan.prefix.length;
    // Stop at the first actual win even if the model included trailing moves.
    for (; executedCount < count && !result.won; executedCount++) {
      const before = result;
      prefix += run._plan.actions[executedCount]; result = replay(level.rows, prefix);
      if (['push', 'step'].includes(run.playStyle)) {
        const changed = stateKey(before.state) !== stateKey(result.state), action = prefix.at(-1);
        run._feedback = { action, changed, goalsFilled: result.state.boxes.filter(b => result.state.goals.includes(b)).length };
        run._recent = [...(run._recent || []), { action, player: { x: result.state.player % 8, y: Math.floor(result.state.player / 8) }, changed }].slice(-12);
        run._visits ||= {}; const key = stateKey(result.state); run._visits[key] = (run._visits[key] || 0) + 1;
      }
    }
    Object.assign(run, { actions: prefix, steps: result.steps, elapsedMs: Math.max(1, until - run.startedAt), note: '正在逐步执行路线' });
    const completedAt = run._plan.at + executedCount * RULES.stepMs;
    if (result.won) this.completeRun(run, level, pet, true, completedAt, '游戏引擎已确认通关');
    else if (count === run._plan.actions.length) {
      delete run._plan;
      if (this.brain.mode === 'model' && (run._round || 0) < (['push', 'step'].includes(run.playStyle) ? 60 : 3) && until < run.deadline && prefix.length < RULES.maxActions) {
        run.phase = 'deciding';
        run.note = '宠物正在根据棋盘重新思考'; this.enqueue('play', target.target, target);
      } else this.completeRun(run, level, pet, false, completedAt, '宠物本次未能通关');
    }
  }
  tick() {
    for (const job of Object.values(this.s.jobs)) if (job.status === 'running' && this.now() > job.leaseUntil) this.failJob(job, '任务连接中断');
    for (const match of Object.values(this.s.challenges)) if (match.status === 'active') {
      for (const side of match.sides) this.advance(side.agent, this.s.levels[side.levelId], this.s.pets[side.petId], { target: `${match.id}:${side.petId}`, matchId: match.id, petId: side.petId, levelId: side.levelId });
      for (const side of match.sides) for (const run of [side.human, side.agent]) {
        if (run.status === 'running' && this.now() > run.deadline) Object.assign(run, { status: 'failed', elapsedMs: RULES.limitMs, finishedAt: run.deadline, note: '挑战超时', ...runScore(false, RULES.limitMs) });
      }
      this.settle(match);
    }
    for (const p of Object.values(this.s.practices)) {
      this.advance(p.run, p.level, this.s.pets[p.petId], { target: `practice:${p.id}`, practiceId: p.id, petId: p.petId, levelId: p.level.id });
      if (p.run.status === 'running' && this.now() > p.run.deadline) this.completeRun(p.run, p.level, this.s.pets[p.petId], false, p.run.deadline, '宠物挑战超时');
    }
    super.tick();
  }
  claimJob(owner, lane = 'any') {
    this.tick();
    const running = Object.values(this.s.jobs).filter(j => j.status === 'running');
    const owns = id => this.s.pets[id]?.owner === owner;
    const participates = match => match?.sides.some(side => owns(side.petId));
    const allowed = job => owner === undefined || (job.kind === 'chat' ? owns(job.petId) : job.practiceId ? owns(job.petId) : job.matchId ? participates(this.s.challenges[job.matchId]) : owns(job.target) || Object.values(this.s.challenges).some(m => participates(m) && m.sides.some(s => s.petId === job.target)));
    const list = Object.values(this.s.jobs).filter(j => j.status === 'pending' && allowed(j)).sort((a, b) => +(a.kind === 'generate') - +(b.kind === 'generate') || a.createdAt - b.createdAt);
    for (const job of list) {
      const preparing = job.kind === 'generate';
      if ((lane === 'preparation' && !preparing) || (lane === 'foreground' && preparing)) continue;
      if (running.filter(j => (j.kind === 'generate') === preparing).length >= (preparing ? 1 : 2)) continue;
      if (job.kind === 'chat') {
        if (running.some(j => j.kind === 'chat' && j.petId === job.petId)) continue;
        const pet = this.s.pets[job.petId], receipt = pet?.chat.requests.find(r => r.id === job.requestId);
        if (!receipt || receipt.status !== 'pending') { job.status = 'cancelled'; continue; }
      }
      if (job.kind === 'play') {
        const run = this.targetRun(job), match = this.s.challenges[job.matchId];
        if (!run || (match && match.status !== 'active') || !['pending', 'running'].includes(run.status)) { job.status = 'cancelled'; continue; }
        if (run.status === 'pending') Object.assign(run, { status: 'running', startedAt: this.now(), deadline: this.now() + RULES.limitMs, method: this.brain.mode, model: this.brain.info().model });
        run.playStyle ||= this.brain.mode === 'model' && this.brain.playEffort === 'none' ? 'push' : 'plan';
        run.effort ??= this.brain.info().playEffort;
        if (['push', 'step'].includes(run.playStyle)) { run.effort = this.brain.deepseek ? 'none' : null; run.phase = 'deciding'; run.turn = (run._round || 0) + 1; }
        run.note = '宠物正在独立思考路线';
      }
      job.status = 'running'; job.claim = randomUUID(); job.leaseUntil = this.now() + (preparing ? 510000 : job.kind === 'chat' ? 60000 : RULES.limitMs + 10000);
      if (job.kind === 'chat') {
        const pet = this.s.pets[job.petId], pendingIds = new Set(pet.chat.requests.filter(r => r.status === 'pending').map(r => r.userId));
        advanceLife(pet, this.now());
        const history = pet.chat.messages.filter(m => !pendingIds.has(m.id)).slice(-19).map(({ role, content }) => ({ role, content }));
        history.push({ role: 'user', content: job.message });
        return { ...job, context: { name: pet.name, gameId: pet.selectedGame, progression: progressionView(pet), life: lifeView(pet, this.now()), history } };
      }
      const level = this.s.levels[job.levelId];
      return { ...job, ...(level ? { rows: level.rows, run: structuredClone(this.targetRun(job)) } : {}) };
    }
    return null;
  }
  finishJob(claim, result) {
    const job = this.s.jobs[claim.id];
    if (!job || job.status !== 'running' || job.claim !== claim.claim) return;
    if (this.now() > job.leaseUntil) { this.failJob(claim, '任务返回已超时'); return; }
    if (job.kind === 'chat') {
      requireThat(typeof result?.reply === 'string' && result.reply.trim() && result.reply.length <= 2000, '宠物回复暂时不可用', 503);
      requireThat(result.action == null || LIFE_ACTIONS.includes(result.action), '宠物行动暂时不可用', 503);
      const pet = this.s.pets[job.petId], receipt = pet.chat.requests.find(r => r.id === job.requestId);
      if (result.action) requestLifeAction(pet, result.action, this.now(), 'conversation');
      const reply = { id: randomUUID(), role: 'assistant', content: result.reply.trim(), createdAt: this.now(), method: result.method, model: result.model || null };
      const messages = [...pet.chat.messages], userIndex = messages.findIndex(m => m.id === receipt.userId);
      if (userIndex >= 0) messages.splice(userIndex + 1, 0, reply);
      else messages.push({ id: receipt.userId, role: 'user', content: job.message, createdAt: this.now() }, reply);
      pet.chat.messages = messages.slice(-60);
      receipt.status = 'complete'; delete receipt.error;
      job.status = 'done'; job.finishedAt = this.now(); delete job.message;
      return;
    }
    if (job.kind === 'generate') {
      const pet = this.s.pets[job.target]; this.attachLevel(pet, result); pet.preparing = false; pet.prepareError = null;
    } else {
      const run = this.targetRun(job), match = this.s.challenges[job.matchId];
      if (!run || run.status !== 'running' || (match && match.status !== 'active')) return;
      run._round = (run._round || 0) + 1;
      if (result.timedOut || this.now() >= run.deadline) this.completeRun(run, this.s.levels[job.levelId], this.s.pets[job.petId], false, run.deadline, '宠物挑战超时');
      else if (result.invalid) {
        run._invalid = (run._invalid || 0) + 1;
        if (['push', 'step'].includes(run.playStyle) && run._invalid < 3) {
          run._feedback = { error: 'Invalid choice or action. Choose one allowed option; board unchanged.' };
          run._plan = { prefix: run.actions || '', actions: '', at: this.now() };
        } else this.completeRun(run, this.s.levels[job.levelId], this.s.pets[job.petId], false, this.now(), '模型返回了非法操作，本次挑战失败');
      } else { run._invalid = 0; run.phase = 'acting'; run._plan = { prefix: run.actions || '', actions: result.actions, at: this.now() }; }
    }
    job.status = 'done'; job.finishedAt = this.now();
    this.tick();
  }
  failJob(claim, reason) {
    const job = this.s.jobs[claim.id];
    if (!job || job.status !== 'running' || job.claim !== claim.claim) return;
    job.status = 'failed'; job.finishedAt = this.now(); job.error = reason;
    if (job.kind === 'chat') { const receipt = this.s.pets[job.petId]?.chat.requests.find(r => r.id === job.requestId); if (receipt) { receipt.status = 'failed'; receipt.error = '宠物暂时没能回复，请重试同一条消息'; } }
    else if (job.kind === 'generate') { const pet = this.s.pets[job.target]; if (pet) { pet.preparing = false; pet.prepareError = '备题服务中断或新关未通过验证，原关卡仍可挑战'; } }
    else if (job.practiceId) { const run = this.targetRun(job); if (run?.status === 'running') Object.assign(run, { status: 'error', note: '宠物服务中断，试玩不计分，请重试' }); }
    else { const match = this.s.challenges[job.matchId], run = this.targetRun(job); if (match?.status === 'active' && ['pending', 'running'].includes(run?.status)) { match.status = 'void'; match.voidReason = '宠物服务中断，本场作废，不计分'; this.abortAgents(match); } }
  }
}
