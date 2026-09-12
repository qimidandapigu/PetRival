import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { generate, parse, replay, RULES, runScore, compareTeams } from '../shared/game.mjs';

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const need = (condition, message, status = 400) => { if (!condition) throw new ApiError(status, message); };
const clean = (text, max) => typeof text === 'string' ? text.trim().slice(0, max) : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const pendingRun = () => ({ status: 'pending', actions: '', score: null });

export class Arena {
  constructor(store, brain, { now = Date.now } = {}) {
    this.store = store; this.s = store.state; this.brain = brain; this.now = now;
    this.generating = new Set(); this.playing = new Set(); this.tasks = new Set(); this.closed = false;
    if (!Object.keys(this.s.pets).length) {
      ['薄荷', '焦糖', '蓝莓'].forEach((name, i) => {
        const pet = this.makePet(null, { name, species: ['sprout', 'fox', 'ghost'][i], intent: '轻松的入门关卡', defense: true }, true);
        this.attachLevel(pet, generate(401 + i));
      });
    }
    for (const pet of Object.values(this.s.pets)) if (pet.preparing) { pet.preparing = false; pet.prepareError = '上次备题被中断，原关卡仍可用'; }
    for (const match of Object.values(this.s.challenges)) if (match.status === 'active') {
      for (const side of match.sides) if (side.agent.status === 'running') side.agent = pendingRun();
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
    need(['sprout', 'fox', 'ghost'].includes(input.species), '请选择宠物类型');
    const pet = { id: randomUUID(), owner, name, species: input.species, intent: clean(input.intent, 240) || '轻松的入门关卡', defense: input.defense === true,
      bot, createdAt: this.now(), score: 0, rankMs: 0, wins: 0, losses: 0, draws: 0, played: 0, readyId: null, preparing: false };
    this.s.pets[pet.id] = pet; return pet;
  }
  attachLevel(pet, result) {
    parse(result.rows);
    need(result.proof && replay(result.rows, result.proof).won, '关卡没有有效通关证明');
    const level = { id: randomUUID(), petId: pet.id, rows: [...result.rows], proof: result.proof, hash: hash(result.rows.join('\n')), method: result.method, createdAt: this.now() };
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
    return { id: p.id, name: p.name, species: p.species, bot: p.bot, score: p.score, rankMs: p.rankMs, played: p.played, wins: p.wins, losses: p.losses, draws: p.draws, ready: !!p.readyId, preparing: p.preparing, defense: p.defense, method: this.s.levels[p.readyId]?.method };
  }
  levelView(id) { const l = this.s.levels[id]; return { id: l.id, rows: l.rows, hash: l.hash, method: l.method }; }
  view(owner) {
    this.tick();
    const pet = this.mine(owner);
    const pets = Object.values(this.s.pets).map(p => this.publicPet(p));
    return { now: this.now(), rules: RULES, mode: this.brain.mode,
      mine: pet ? { ...this.publicPet(pet), intent: pet.intent, prepareError: pet.prepareError, level: this.levelView(pet.readyId) } : null,
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
        const safe = run => {
          const { actions, ...rest } = run;
          return { ...rest, ...(reveal && run.status !== 'running' ? { actions } : {}) };
        };
        return { pet: this.publicPet(this.s.pets[s.petId]), own: isOwn, level: this.levelView(s.levelId), human: safe(s.human), agent: safe(s.agent), total: s.total };
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
      this.playing.add(key); side.agent = { ...pendingRun(), status: 'running', startedAt: this.now(), method: this.brain.mode }; this.store.save();
      this.task(async () => {
        try {
          const rows = [...this.s.levels[side.levelId].rows];
          const result = await this.brain.play(rows);
          if (this.closed || match.status !== 'active' || side.agent.status !== 'running') return;
          const executed = replay(rows, result.actions);
          const elapsedMs = this.now() - side.agent.startedAt + result.actions.length * RULES.stepMs;
          side.agent = { ...side.agent, actions: result.actions, status: executed.won && elapsedMs <= RULES.limitMs ? 'cleared' : 'failed', elapsedMs, steps: executed.steps, note: result.note, method: result.method };
          Object.assign(side.agent, runScore(side.agent.status === 'cleared', elapsedMs));
        } catch {
          if (!this.closed && match.status === 'active') {
            // Infrastructure failure is not a contestant failure. No fabricated ranked penalty.
            match.status = 'void'; match.voidReason = '宠物执行服务失败，本场作废，不计分';
          }
        } finally { this.playing.delete(key); this.settle(match); this.store.save(); }
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
    for (const m of Object.values(this.s.challenges)) {
      if (m.status !== 'active') continue;
      if (this.now() > m.expiresAt) { m.status = 'void'; m.voidReason = '24 小时内未完成双方挑战，本场作废，不计分'; changed = true; continue; }
      for (const side of m.sides) {
        const run = side.human;
        if (run.status === 'running' && this.now() > run.deadline) {
          side.human = { ...run, status: 'failed', elapsedMs: RULES.limitMs, ...runScore(false, RULES.limitMs), note: '挑战超时' }; changed = true;
        }
      }
      const previous = m.status; this.settle(m); if (m.status !== previous) changed = true;
    }
    if (changed) this.store.save();
  }
  resume() { for (const m of Object.values(this.s.challenges)) if (m.status === 'active') this.launchAgents(m); }
  async practice(owner) {
    const pet = this.mine(owner); need(pet, '请先领养宠物');
    const level = this.levelView(pet.readyId), start = this.now();
    const result = await this.brain.play(level.rows);
    const verified = replay(level.rows, result.actions);
    return { level, ...result, won: verified.won, elapsedMs: this.now() - start + result.actions.length * RULES.stepMs, ranked: false };
  }
}
