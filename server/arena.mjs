import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { generate, parse, replay, RULES, runScore, compareTeams } from '../shared/game.mjs';
import { PET_SPECIES, defaultAppearance, parsePetFile } from '../shared/pet.mjs';
import { GAMES, ensureGrowth, progressionView, recordVerifiedClear } from '../shared/progression.mjs';
import { LIFE_ACTIONS, ensureLife, advanceLife, requestLifeAction, lifeView } from '../shared/life.mjs';

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const need = (condition, message, status = 400) => { if (!condition) throw new ApiError(status, message); };
const clean = (text, max) => typeof text === 'string' ? text.trim().slice(0, max) : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const pendingRun = () => ({ status: 'pending', actions: '', score: null });

export class Arena {
  constructor(store, brain, { now = Date.now, recover = true } = {}) {
    this.store = store; this.s = store.state; this.brain = brain; this.now = now;
    this.generating = new Set(); this.playing = new Set(); this.tasks = new Set(); this.closed = false;
    this.agentControllers = new Map(); this.practices = new Map();
    this.chatQueues = new Map();
    if (!Object.keys(this.s.pets).length) {
      ['薄荷', '焦糖', '蓝莓'].forEach((name, i) => {
        const pet = this.makePet(null, { name, species: ['sprout', 'fox', 'ghost'][i], intent: '轻松的入门关卡', defense: true }, true);
        this.attachLevel(pet, generate(401 + i));
      });
    }
    for (const pet of Object.values(this.s.pets)) {
      ensureGrowth(pet);
      ensureLife(pet, this.now());
      if (!pet.chat) pet.chat = { messages: [], requests: [] };
      if (recover) for (const request of pet.chat.requests) if (request.status === 'pending') request.status = 'failed';
      if (recover && pet.preparing) { pet.preparing = false; pet.prepareError = '上次备题被中断，原关卡仍可用'; }
    }
    for (const match of Object.values(this.s.challenges)) if (recover && match.status === 'active') {
      if (match.sides.some(side => side.agent.status === 'running')) {
        // Restart cannot replay a published prefix with a fresh competitive clock.
        match.status = 'void'; match.voidReason = '服务重启中断了宠物执行，本场作废，不计分';
        this.abortAgents(match);
      }
    }
    store.save();
  }
  task(fn) {
    const promise = Promise.resolve().then(fn);
    this.tasks.add(promise);
    promise.catch(() => {}).finally(() => this.tasks.delete(promise));
    return promise;
  }
  async idle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
  session() {
    need(Object.keys(this.s.sessions).length < 10000, '访客容量已满', 503);
    const token = randomBytes(32).toString('hex'), owner = randomUUID();
    this.s.sessions[hash(token)] = { owner, createdAt: this.now() }; this.store.save();
    return { token, owner };
  }
  owner(token) { return typeof token === 'string' ? this.s.sessions[hash(token)]?.owner : undefined; }
  mine(owner) { return Object.values(this.s.pets).find(p => p.owner === owner); }
  makePet(owner, input, bot = false) {
    const name = clean(input.name, 16);
    need(name.length >= 1, '请给宠物起个名字');
    need(PET_SPECIES.includes(input.species), '请选择宠物类型');
    const pet = { id: randomUUID(), owner, name, species: input.species, intent: clean(input.intent, 240) || '轻松的入门关卡', defense: input.defense === true,
      bot, createdAt: this.now(), score: 0, rankMs: 0, wins: 0, losses: 0, draws: 0, played: 0, readyId: null, preparing: false };
    pet.appearance = defaultAppearance(pet.species);
    ensureGrowth(pet); ensureLife(pet, this.now()); pet.chat = { messages: [], requests: [] };
    this.s.pets[pet.id] = pet; return pet;
  }
  attachLevel(pet, result) {
    parse(result.rows);
    need(result.proof && replay(result.rows, result.proof).won, '关卡没有有效通关证明');
    const level = { id: randomUUID(), petId: pet.id, rows: [...result.rows], proof: result.proof, hash: hash(result.rows.join('\n')), method: result.method, model: result.model || null, createdAt: this.now() };
    this.s.levels[level.id] = level; pet.readyId = level.id;
    return level;
  }
  createPet(owner, input) {
    need(!this.mine(owner), '每个访客只能拥有一只宠物', 409);
    const pet = this.makePet(owner, input);
    // Verified starter is already prepared; the user's requested model/algorithm replacement happens off the critical path.
    this.attachLevel(pet, generate(randomBytes(4).readUInt32LE(), pet.intent));
    this.store.save(); this.prepare(pet); return pet;
  }
  prepare(pet, intent) {
    if (this.generating.has(pet.id) || this.closed) return;
    if (intent !== undefined) pet.intent = clean(intent, 240) || pet.intent;
    this.generating.add(pet.id); pet.preparing = true; pet.prepareError = null; this.store.save();
    this.task(async () => {
      try {
        const result = await this.brain.generate(pet.intent, randomBytes(4).readUInt32LE());
        if (!this.closed) this.attachLevel(pet, result);
      } catch { pet.prepareError = '备题未通过验证或服务失败，保留原关卡；稍后可重试'; }
      finally { this.generating.delete(pet.id); pet.preparing = false; this.store.save(); }
    });
  }
  publicPet(p) {
    return { id: p.id, name: p.name, species: p.species, appearance: p.appearance || defaultAppearance(p.species), bot: p.bot, score: p.score, rankMs: p.rankMs, played: p.played, wins: p.wins, losses: p.losses, draws: p.draws, ready: !!p.readyId, preparing: p.preparing, defense: p.defense, method: this.s.levels[p.readyId]?.method,
      selectedGame: p.selectedGame, progression: progressionView(p) };
  }
  selectGame(owner, input) {
    const pet = this.mine(owner); need(pet, '请先领养宠物', 409);
    need(input.gameId === 'sokoban', '目前只开放推箱子', 422);
    pet.selectedGame = input.gameId; this.store.save();
    return this.view(owner);
  }
  chatView(owner) {
    const pet = this.mine(owner); need(pet, '请先领养宠物', 409);
    if (advanceLife(pet, this.now())) this.store.save();
    return { messages: pet.chat.messages.map(message => ({ ...message })), life: lifeView(pet, this.now()) };
  }
  chat(owner, input) {
    const pet = this.mine(owner); need(pet, '请先领养宠物', 409);
    need(typeof input.message === 'string' && input.message.trim().length > 0, '请输入想对宠物说的话', 422);
    need(input.message.length <= 1000, '每条消息最多 1000 个字符', 422);
    need(input.requestId === undefined || (typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)), '消息标识无效', 422);
    const message = input.message.trim(), requestId = input.requestId || randomUUID();
    // A pet has one private conversation: queued sends see all earlier replies, even under concurrent requests.
    const previous = this.chatQueues.get(pet.id) || Promise.resolve();
    const operation = this.task(async () => {
      await previous.catch(() => {});
      need(!this.closed, '对话服务正在关闭，请稍后再试', 503);
      let request = pet.chat.requests.find(item => item.id === requestId);
      if (request) {
        need(request.messageHash === hash(message), '消息标识已用于另一条消息', 409);
        if (request.status === 'complete') return this.chatView(owner);
      } else {
        request = { id: requestId, messageHash: hash(message), userId: randomUUID(), status: 'pending' };
        pet.chat.requests.push(request);
        pet.chat.messages.push({ id: request.userId, role: 'user', content: message, createdAt: this.now() });
      }
      request.status = 'pending';
      pet.chat.messages = pet.chat.messages.slice(-60);
      // Keep compact request receipts after visible history is trimmed: a late
      // retry must never replay an already accepted conversation action.
      this.store.save();
      try {
        const retryingEarlier = pet.chat.messages.at(-1)?.id !== request.userId;
        const history = pet.chat.messages.slice(retryingEarlier ? -19 : -20).map(({ role, content }) => ({ role, content }));
        // Retrying an older failed send should respond to that send, not an unrelated later message.
        if (retryingEarlier) history.push({ role: 'user', content: message });
        if (advanceLife(pet, this.now())) this.store.save();
        const result = await this.brain.chat({ name: pet.name, gameId: pet.selectedGame, progression: progressionView(pet), life: lifeView(pet, this.now()), history });
        need(!this.closed, '对话服务正在关闭，请稍后再试', 503);
        need(typeof result?.reply === 'string' && result.reply.trim().length > 0 && result.reply.length <= 4000, '宠物回复暂时不可用，请重试', 503);
        need(result.action === undefined || result.action === null || LIFE_ACTIONS.includes(result.action), '宠物行动暂时不可用，请重试', 503);
        // Commit the validated reply, action schedule, and idempotency receipt
        // together. No await can interleave the ticker inside this operation.
        const previousLife = structuredClone(pet.life), previousMessages = pet.chat.messages;
        try {
          if (result.action) requestLifeAction(pet, result.action, this.now(), 'conversation');
          const reply = { id: randomUUID(), role: 'assistant', content: result.reply.trim(), createdAt: this.now(), method: result.method, model: result.model || null };
          pet.chat.messages = [...pet.chat.messages, reply].slice(-60); request.status = 'complete';
          this.store.save();
        } catch (error) {
          pet.life = previousLife; pet.chat.messages = previousMessages;
          throw error;
        }
        return { messages: pet.chat.messages.map(message => ({ ...message })), life: lifeView(pet, this.now()) };
      } catch (error) {
        request.status = 'failed'; this.store.save();
        throw error instanceof ApiError ? error : new ApiError(503, '宠物暂时没能回复，请稍后重试');
      }
    });
    this.chatQueues.set(pet.id, operation);
    const clear = () => { if (this.chatQueues.get(pet.id) === operation) this.chatQueues.delete(pet.id); };
    operation.then(clear, clear);
    return operation;
  }
  updateAppearance(owner, input) {
    const pet = this.mine(owner); need(pet, '请先领养宠物', 409);
    need(Object.keys(input).every(k => ['name', 'species', 'appearance'].includes(k)), '外观只接受名字、类型和像素，不能修改身份或积分', 422);
    let cosmetic;
    try { cosmetic = parsePetFile({ format: 'petrival-pet', version: 1, ...input }); }
    catch (error) { throw new ApiError(422, error.message); }
    Object.assign(pet, cosmetic); this.store.save(); return this.publicPet(pet);
  }
  levelView(id) { const l = this.s.levels[id]; return { id: l.id, rows: l.rows, hash: l.hash, method: l.method, model: l.model || null }; }
  view(owner) {
    this.tick();
    const pet = this.mine(owner);
    const pets = Object.values(this.s.pets).map(p => this.publicPet(p));
    return { now: this.now(), rules: RULES, games: GAMES, mode: this.brain.mode, model: this.brain.info().model, playEffort: this.brain.info().playEffort,
      mine: pet ? { ...this.publicPet(pet), life: lifeView(pet, this.now()), intent: pet.intent, prepareError: pet.prepareError, level: this.levelView(pet.readyId) } : null,
      pets: pets.filter(p => p.id !== pet?.id),
      leaderboard: pets.filter(p => !p.bot).sort((a, b) => b.score - a.score || a.rankMs - b.rankMs || a.id.localeCompare(b.id)),
      challenges: pet ? Object.values(this.s.challenges).filter(m => m.sides.some(s => s.petId === pet.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(m => this.matchView(m, owner)) : [],
    };
  }
  matchFor(id, owner) {
    const m = this.s.challenges[id], pet = this.mine(owner);
    need(m && pet && m.sides.some(s => s.petId === pet.id), '挑战不存在或无权访问', 404);
    return m;
  }
  matchView(m, owner) {
    const own = m.sides.find(s => this.s.pets[s.petId].owner === owner);
    const reveal = ['cleared', 'failed'].includes(own?.human.status) || m.status !== 'active';
    return { id: m.id, training: m.training, status: m.status, createdAt: m.createdAt, expiresAt: m.expiresAt, winner: m.winner, voidReason: m.voidReason,
      sides: m.sides.map(s => {
        const isOwn = this.s.pets[s.petId].owner === owner;
        const safe = (run, ownLive = false) => {
          const { actions, ...rest } = run;
          return { ...rest, ...(ownLive || (reveal && run.status !== 'running') ? { actions } : {}) };
        };
        return { pet: this.publicPet(this.s.pets[s.petId]), own: isOwn, level: this.levelView(s.levelId), human: safe(s.human), agent: safe(s.agent, isOwn), total: s.total };
      }),
    };
  }
  challenge(owner, opponentId) {
    this.tick();
    const me = this.mine(owner), rival = this.s.pets[opponentId];
    need(me && rival && me.id !== rival.id, '请选择另一只宠物');
    need(rival.defense, '对方未开启守擂', 409);
    need(me.readyId && rival.readyId, '双方需要备好已验证关卡', 409);
    const matches = Object.values(this.s.challenges);
    need(matches.filter(m => m.status === 'active' && m.sides.some(s => s.petId === me.id)).length < 3, '请先完成已有挑战（最多三场）', 409);
    need(matches.filter(m => m.status === 'active' && m.sides.some(s => s.petId === rival.id)).length < 3, '对方已有三场挑战，请换个对手', 409);
    need(!matches.some(m => m.status === 'active' && m.sides.some(s => s.petId === me.id) && m.sides.some(s => s.petId === rival.id)), '双方已有进行中的挑战', 409);
    need(!matches.some(m => m.status === 'done' && m.sides.some(s => s.petId === me.id && s.levelId === rival.readyId) && m.sides.some(s => s.petId === rival.id && s.levelId === me.readyId)), '这组题已交手，换好新题再挑战', 409);
    const match = { id: randomUUID(), training: rival.bot, status: 'active', createdAt: this.now(), expiresAt: this.now() + 24 * 3600000,
      sides: [me, rival].map((p, i) => ({ petId: p.id, levelId: [rival, me][i].readyId, human: p.bot ? { status: 'not_applicable', score: null, actions: '' } : pendingRun(), agent: pendingRun() })) };
    this.s.challenges[match.id] = match; this.store.save();
    // Enqueue only: no generation/model await occurs before the challenge is returned.
    this.task(() => { this.launchAgents(match); this.prepare(me); this.prepare(rival); });
    return this.matchView(match, owner);
  }
  launchAgents(match) {
    if (this.closed || match.status !== 'active') return;
    for (const side of match.sides) {
      const key = `${match.id}:${side.petId}`;
      if (side.agent.status !== 'pending' || this.playing.has(key)) continue;
      const controller = new AbortController(); this.agentControllers.set(key, controller);
      this.playing.add(key); side.agent = { ...pendingRun(), status: 'running', startedAt: this.now(), deadline: this.now() + RULES.limitMs,
        method: this.brain.mode, model: this.brain.info().model, effort: this.brain.info().playEffort, note: '正在思考路线，你可以同时开始闯关' }; this.store.save();
      this.task(async () => {
        try {
          const rows = [...this.s.levels[side.levelId].rows];
          const result = await this.brain.play(rows, { signal: controller.signal, onProgress: progress => {
            if (this.closed || match.status !== 'active' || side.agent.status !== 'running') return;
            // Persist the engine-executed prefix, never the model's unexecuted plan.
            Object.assign(side.agent, progress); this.store.save();
          } });
          if (this.closed || match.status !== 'active' || side.agent.status !== 'running') return;
          const executed = replay(rows, result.actions);
          const elapsedMs = result.elapsedMs;
          side.agent = { ...side.agent, actions: result.actions, status: executed.won && !result.timedOut && elapsedMs <= RULES.limitMs ? 'cleared' : 'failed', elapsedMs, steps: executed.steps, note: result.note, method: result.method, model: result.model };
          Object.assign(side.agent, runScore(side.agent.status === 'cleared', elapsedMs));
          if (side.agent.status === 'cleared') recordVerifiedClear(this.s.pets[side.petId], this.s.levels[side.levelId].hash, this.now());
        } catch {
          if (!this.closed && match.status === 'active' && side.agent.status === 'running') {
            // Infrastructure failure is not a contestant failure. No fabricated ranked penalty.
            match.status = 'void'; match.voidReason = '宠物执行服务失败，本场作废，不计分';
            this.abortAgents(match);
          }
        } finally { this.playing.delete(key); this.agentControllers.delete(key); this.settle(match); this.store.save(); }
      });
    }
  }
  start(owner, id) {
    this.tick(); const match = this.matchFor(id, owner);
    need(match.status === 'active', '挑战已经结束', 409);
    const side = match.sides.find(s => this.s.pets[s.petId].owner === owner);
    if (side.human.status === 'pending') {
      side.human = { ...pendingRun(), status: 'running', startedAt: this.now(), deadline: this.now() + RULES.limitMs }; this.store.save();
    }
    return this.matchView(match, owner);
  }
  finish(owner, id, input) {
    this.tick(); const match = this.matchFor(id, owner);
    const side = match.sides.find(s => this.s.pets[s.petId].owner === owner);
    if (['cleared', 'failed'].includes(side.human.status)) return this.matchView(match, owner);
    need(match.status === 'active' && side.human.status === 'running', '请先开始挑战', 409);
    let result;
    try { result = replay(this.s.levels[side.levelId].rows, input.actions); }
    catch (e) { throw new ApiError(422, e.message); }
    need(result.won || input.giveUp === true, '操作记录尚未通关；可以继续或认输', 422);
    const elapsedMs = Math.max(1, this.now() - side.human.startedAt);
    const success = result.won && elapsedMs <= RULES.limitMs;
    side.human = { ...side.human, status: success ? 'cleared' : 'failed', actions: input.actions, elapsedMs, steps: result.steps, ...runScore(success, elapsedMs) };
    this.settle(match); this.store.save(); return this.matchView(match, owner);
  }
  settle(match) {
    if (match.status !== 'active') return;
    const finished = r => ['cleared', 'failed', 'not_applicable'].includes(r.status);
    if (!match.sides.every(s => finished(s.human) && finished(s.agent))) return;
    for (const side of match.sides) {
      const runs = [side.human, side.agent].filter(r => r.status !== 'not_applicable');
      side.total = { score: runs.reduce((n, r) => n + r.score, 0), rankMs: runs.reduce((n, r) => n + r.rankMs, 0) };
    }
    match.status = 'done'; match.finishedAt = this.now();
    if (match.training) { match.winner = null; return; }
    const comparison = compareTeams(match.sides[0].total, match.sides[1].total);
    match.winner = comparison === 0 ? null : match.sides[comparison < 0 ? 0 : 1].petId;
    for (const side of match.sides) {
      const pet = this.s.pets[side.petId];
      pet.score += side.total.score; pet.rankMs += side.total.rankMs; pet.played++;
      if (!match.winner) pet.draws++; else if (match.winner === pet.id) pet.wins++; else pet.losses++;
    }
  }
  tick() {
    let changed = false;
    for (const pet of Object.values(this.s.pets)) if (advanceLife(pet, this.now())) changed = true;
    for (const m of Object.values(this.s.challenges)) {
      if (m.status !== 'active') continue;
      if (this.now() > m.expiresAt) { m.status = 'void'; m.voidReason = '24 小时内未完成双方挑战，本场作废，不计分'; this.abortAgents(m); changed = true; continue; }
      for (const side of m.sides) {
        const run = side.human;
        if (run.status === 'running' && this.now() > run.deadline) {
          side.human = { ...run, status: 'failed', elapsedMs: RULES.limitMs, ...runScore(false, RULES.limitMs), note: '挑战超时' }; changed = true;
        }
        if (side.agent.status === 'running' && this.now() > side.agent.deadline) {
          side.agent = { ...side.agent, status: 'failed', elapsedMs: RULES.limitMs, ...runScore(false, RULES.limitMs), note: '宠物挑战超时' };
          this.agentControllers.get(`${m.id}:${side.petId}`)?.abort(new Error('宠物挑战超时')); changed = true;
        }
      }
      const previous = m.status; this.settle(m); if (m.status !== previous) changed = true;
    }
    if (changed) this.store.save();
  }
  abortAgents(match) {
    for (const side of match.sides) {
      if (['pending', 'running'].includes(side.agent.status)) side.agent = { ...side.agent, status: 'error', note: match.voidReason || '本场挑战已停止' };
      this.agentControllers.get(`${match.id}:${side.petId}`)?.abort(new Error('本场挑战已停止'));
    }
  }
  resume() { for (const m of Object.values(this.s.challenges)) if (m.status === 'active') this.launchAgents(m); }
  async practice(owner) {
    const pet = this.mine(owner); need(pet, '请先领养宠物');
    const level = this.levelView(pet.readyId);
    const result = await this.brain.play(level.rows);
    const verified = replay(level.rows, result.actions);
    const success = verified.won && !result.timedOut && result.elapsedMs <= RULES.limitMs;
    if (!this.closed && success) { recordVerifiedClear(pet, level.hash, this.now()); this.store.save(); }
    return { level, ...result, won: success, ranked: false };
  }
  practiceView(practice) { return { id: practice.id, level: practice.level, run: { ...practice.run }, ranked: false }; }
  getPractice(owner, id) {
    const practice = this.practices.get(owner);
    need(practice && practice.id === id, '试玩不存在或无权访问', 404);
    return this.practiceView(practice);
  }
  startPractice(owner, { style = this.brain.playEffort === 'none' ? 'push' : 'plan' } = {}) {
    need(['plan', 'step', 'push'].includes(style), '未知试玩方式');
    const pet = this.mine(owner); need(pet, '请先领养宠物');
    const existing = this.practices.get(owner);
    if (existing?.run.status === 'running') return this.practiceView(existing);
    // Only the most recent practice per owner is retained; inactive sessions expire after one hour.
    for (const [key, previous] of this.practices) if (previous.run.status !== 'running' && this.now() - previous.createdAt > 3600000) this.practices.delete(key);
    const practice = { id: randomUUID(), level: this.levelView(pet.readyId), createdAt: this.now(),
      run: { ...pendingRun(), status: 'running', startedAt: this.now(), deadline: this.now() + RULES.limitMs, method: this.brain.mode, model: this.brain.info().model, effort: this.brain.info().playEffort,
        playStyle: this.brain.mode === 'model' ? style : 'plan',
        ...(style !== 'plan' && this.brain.mode === 'model' ? { effort: this.brain.deepseek ? 'none' : null, phase: 'deciding' } : {}),
        note: style !== 'plan' ? '正在选择下一步' : '正在思考路线，你可以同时开始闯关' } };
    this.practices.set(owner, practice);
    this.task(async () => {
      try {
        const result = await this.brain.play(practice.level.rows, { style, onProgress: progress => { if (!this.closed) Object.assign(practice.run, progress); } });
        if (this.closed) return;
        const success = replay(practice.level.rows, result.actions).won && !result.timedOut && result.elapsedMs <= RULES.limitMs;
        practice.run = { ...practice.run, ...result, status: success ? 'cleared' : 'failed', ...runScore(success, result.elapsedMs) };
        if (success) { recordVerifiedClear(pet, practice.level.hash, this.now()); this.store.save(); }
      } catch { if (!this.closed) practice.run = { ...practice.run, status: 'error', note: '宠物执行服务失败，试玩不计分' }; }
    });
    return this.practiceView(practice);
  }
}
