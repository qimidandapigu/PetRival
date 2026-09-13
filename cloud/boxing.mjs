import { randomUUID } from 'node:crypto';
import { BoxingArena } from '../server/boxing-arena.mjs';
import { BOXING, ACTIONS, stepBout, fighterObservation } from '../shared/boxing.mjs';
import { ApiError } from '../server/arena.mjs';
import { boxingSkillDecision } from '../server/competition-skill.mjs';

const bouts = match => [[match.petBout, 'pet', false], ...match.humans.map((b, i) => [b, `human${i}`, true])];
const skillFor = (match, label, fighter) => match._skills?.[label === 'pet' ? fighter : 1 - Number(label.slice(5))] || null;
export class CloudBoxing extends BoxingArena {
  constructor(arena, brain, options = {}) { super(arena, brain, { ...options, autoTick: false, recover: false }); }
  ensureControllers(match) {
    for (const [bout, , human] of bouts(match)) if (bout.status === 'running') {
      bout._controls ||= {};
      for (const i of human ? [1] : [0, 1]) bout._controls[i] ||= { queue: [], command: 'idle', until: 0, failures: 0, lastRequest: 0 };
    }
  }
  view(owner) { this.tick(); return { ...super.view(owner), storage: 'D1' }; }
  create(owner, id) {
    this.tick();
    if (Object.keys(this.s.boxingMatches).length >= 2000) throw new ApiError(503, '本轮拳赛名额已满');
    return super.create(owner, id);
  }
  start(owner, id) { this.tick(); return super.start(owner, id); }
  input(owner, id, input) { this.tick(); return super.input(owner, id, input); }
  surrender(owner, id) { this.tick(); return super.surrender(owner, id); }
  get(owner, id) {
    this.tick();
    return JSON.parse(JSON.stringify(super.get(owner, id), (key, value) => key.startsWith('_') ? undefined : value));
  }
  tick() {
    for (const match of Object.values(this.s.boxingMatches)) {
      if (match.status !== 'active') continue;
      if (this.now() >= match.expiresAt) { match.status = 'void'; match.reason = '24 小时未完成，本场作废'; continue; }
      this.ensureControllers(match);
      for (const [bout, label, human] of bouts(match)) {
        if (bout.status !== 'running') continue;
        for (const c of Object.values(bout._controls)) if (c.claim && this.now() > c.leaseUntil) {
          delete c.claim; c.failures++;
          if (c.failures >= 3) { match.status = 'void'; match.reason = '模型连续三次连接中断，本场作废，不计分'; }
        }
        if (match.status !== 'active') break;
        const target = Math.min(BOXING.limitMs / BOXING.tickMs, Math.max(0, Math.floor((this.now() - bout.startedAt) / BOXING.tickMs)));
        while (bout.frame < target && bout.status === 'running') {
          const at = bout.startedAt + (bout.frame + 1) * BOXING.tickMs;
          const command = i => {
            const c = bout._controls[i], skill = skillFor(match, label, i);
            if (skill?.gameId === 'boxing') {
              if (bout.frame >= (c.skillUntil || 0)) { const decision = boxingSkillDecision(skill, fighterObservation(bout, i)); c.skillChoice = decision.choice; c.skillStatus = decision.status; c.skillUntil = bout.frame + BOXING.commandTicks; }
              if (c.skillChoice != null) { bout.decisions[i] = { source: 'skill', status: 'ready', skillStatus: c.skillStatus }; return c.skillChoice; }
            }
            if (this.brain.mode === 'algorithm') {
              bout.decisions[i] = { source: 'algorithm', status: 'ready', skillStatus: c.skillStatus };
              const o = fighterObservation(bout, i), phase = Math.floor(bout.frame / 12) % 6;
              return o.distance > 110 ? 'advance' : phase === 0 ? 'guard' : phase === 1 ? 'retreat' : phase === 4 ? 'heavy' : 'jab';
            }
            if (bout.frame >= c.until) { c.command = c.queue.shift() || 'idle'; c.until = bout.frame + (c.command === 'idle' ? 1 : BOXING.commandTicks); }
            return c.command;
          };
          let first = human ? at - bout.lastInputAt < 1500 ? bout.input : 'idle' : command(0);
          if (human && bout.pendingPunch && !bout.fighters[0].attack && !bout.fighters[0].stun) {
            if (at <= bout.pendingPunch.expiresAt) first = bout.pendingPunch.action;
            bout.pendingPunch = null;
          }
          stepBout(bout, [first, command(1)]);
        }
      }
      this.settle(match);
    }
  }
  control(claim) {
    const match = this.s.boxingMatches[claim.matchId], entry = match && bouts(match).find(([, label]) => label === claim.label);
    return { match, bout: entry?.[0], control: entry?.[0]._controls?.[claim.fighter] };
  }
  claim(owner) {
    this.tick(); if (this.brain.mode !== 'model') return null;
    const active = Object.values(this.s.boxingMatches).filter(m => m.status === 'active');
    const inFlight = active.flatMap(m => bouts(m).flatMap(([b]) => Object.values(b._controls || {}))).filter(c => c.claim);
    if (inFlight.length >= 2) return null;
    const mine = this.arena.mine(owner); if (!mine) return null;
    const candidates = active.filter(m => m.petIds.includes(mine.id)).flatMap(match => bouts(match).filter(([bout]) => bout.status === 'running').flatMap(([bout, label]) => Object.entries(bout._controls).map(([fighter, c]) => ({ match, bout, label, fighter, c })))).sort((a, b) => a.c.lastRequest - b.c.lastRequest);
    for (const { match, bout, label, fighter, c } of candidates) {
        if (c.claim || c.queue.length >= 2 || this.now() - c.lastRequest < 700) continue;
        const skill = boxingSkillDecision(skillFor(match, label, Number(fighter)), fighterObservation(bout, Number(fighter)));
        c.skillStatus = skill.status;
        if (skill.choice !== null) continue;
        c.claim = randomUUID(); c.leaseUntil = this.now() + 8000; c.lastRequest = this.now();
        bout.decisions[fighter] = { source: 'model', status: 'thinking', at: this.now(), calls: bout.decisions[fighter]?.calls || 0, skillStatus: c.skillStatus };
        return { claim: c.claim, matchId: match.id, label, fighter: Number(fighter), observation: fighterObservation(bout, Number(fighter)) };
    }
    return null;
  }
  finish(claim, result) {
    this.tick(); const { match, bout, control: c } = this.control(claim);
    if (!c || c.claim !== claim.claim || match.status !== 'active' || bout.status !== 'running') return;
    if (!Array.isArray(result?.actions) || result.actions.length < 1 || result.actions.length > 3 || !result.actions.every(a => ACTIONS.includes(a))) { this.fail(claim); return; }
    delete c.claim; c.failures = 0; c.queue = [...c.queue, ...result.actions].slice(0, 4);
    bout.decisions[claim.fighter] = { source: 'model', status: 'ready', at: this.now(), calls: (bout.decisions[claim.fighter]?.calls || 0) + 1, skillStatus: c.skillStatus };
  }
  fail(claim) {
    const { match, bout, control: c } = this.control(claim);
    if (!c || c.claim !== claim.claim || match.status !== 'active' || bout.status !== 'running') return;
    delete c.claim; c.failures++;
    bout.decisions[claim.fighter] = { source: 'model', status: 'unavailable', at: this.now(), calls: bout.decisions[claim.fighter]?.calls || 0 };
    if (c.failures >= 3) { match.status = 'void'; match.reason = '模型连续三次响应异常，本场作废，不计分'; }
  }
}

export async function executeBoxing(brain, claim) {
  return brain.json([
    { role: 'system', content: 'Control a pixel boxing fighter. Return JSON {"actions":["advance","jab","retreat"]}, 1 to 3 actions, each 0.5 seconds. Allowed idle, advance, retreat, jab, heavy, guard. Idle does NOT guard. Walk speed 220/sec; jab range114 damage8*power startup0.1s total0.4s; heavy range140 damage16*power startup0.25s total0.8s. Guard reduces damage to20%; cannot attack. Fighters cannot pass each other. Approach when far; attack and retreat in range. Timeout compares remaining HP percentage. You see visible current state only.' },
    { role: 'user', content: JSON.stringify(claim.observation) },
  ], { playEffort: 'none', timeoutMs: 5000, maxTokens: 1024 });
}
