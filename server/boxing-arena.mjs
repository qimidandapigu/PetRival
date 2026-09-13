import { randomUUID } from 'node:crypto';
import { ApiError } from './arena.mjs';
import { BOXING, ACTIONS, newBout, stepBout, finishBout, boxingScore, fighterObservation } from '../shared/boxing.mjs';
import { boxingSkillDecision } from './competition-skill.mjs';
const need = (ok, text, status = 400) => { if (!ok) throw new ApiError(status, text); };
const terminal = bout => bout?.status === 'done';
export class BoxingArena {
  constructor(arena, brain, { now = Date.now, autoTick = true, recover = true } = {}) {
    this.arena = arena; this.brain = brain; this.now = now; this.store = arena.store; this.s = arena.s;
    this.s.boxingMatches ??= {}; this.controllers = new Map(); this.pending = new Set(); this.closed = false; this.lastSave = now();
    if (recover) for (const match of Object.values(this.s.boxingMatches)) if (match.status === 'active' && [match.petBout, ...match.humans].some(b => b?.status === 'running')) { match.status = 'void'; match.reason = '服务重启，本场作废，不扣分'; }
    this.store.save();
    if (autoTick) { this.timer = setInterval(() => this.tick(), BOXING.tickMs); this.timer.unref(); }
  }
  cosmetic(id) { const p = this.s.pets[id]; return { id: p.id, name: p.name, species: p.species, appearance: p.appearance, bot: p.bot }; }
  view(owner) {
    const mine = this.arena.mine(owner);
    return { mine: mine ? this.cosmetic(mine.id) : null, mode: this.brain.mode, model: this.brain.info().model, effort: this.brain.mode === 'model' ? 'none' : null,
      pets: Object.values(this.s.pets).filter(p => p.id !== mine?.id && p.defense).map(p => this.cosmetic(p.id)),
      matches: Object.values(this.s.boxingMatches).filter(m => m.petIds.includes(mine?.id)).sort((a,b) => b.createdAt-a.createdAt).slice(0,20).map(m => ({ id:m.id, status:m.status, training:m.training, names:m.petIds.map(id => this.s.pets[id].name) })),
      leaderboard: Object.values(this.s.pets).filter(p => !p.bot).map(p => ({ ...this.cosmetic(p.id), ...(p.boxingRank || {score:0, rankMs:0, played:0, wins:0}) })).sort((a,b) => b.score-a.score || a.rankMs-b.rankMs) };
  }
  owned(owner, id) { const match = this.s.boxingMatches[id], pet = this.arena.mine(owner); need(match && pet && match.petIds.includes(pet.id), '无权查看这场拳赛', 404); return {match, side:match.petIds.indexOf(pet.id)}; }
  makeBout(multiplier) { return { ...newBout(multiplier), startedAt:this.now()+2200, lastInputAt:0, pendingPunch:null, input:'idle', seq:0, decisions:[null,null] }; }
  create(owner, opponentId) {
    const me = this.arena.mine(owner), opponent = this.s.pets[opponentId];
    need(me && opponent && me.id !== opponent.id && opponent.defense, '请选择已开启守擂的对手');
    const matches = Object.values(this.s.boxingMatches);
    const existing = matches.find(m => m.status === 'active' && m.petIds.includes(me.id) && m.petIds.includes(opponent.id));
    if (existing) return this.get(owner, existing.id);
    need(matches.filter(m => m.status==='active' && m.petIds.includes(me.id)).length < 3, '请先完成已有拳赛', 409);
    const match = { id:randomUUID(), createdAt:this.now(), expiresAt:this.now()+86400000, petIds:[me.id,opponent.id], _skills:[me,opponent].map(p=>structuredClone(p.competitionSkill || null)), status:'active', training:opponent.bot, petBout:this.makeBout(1), humans:[this.makeBout(5),opponent.bot ? {status:'not_applicable'} : {status:'pending'}] };
    this.s.boxingMatches[match.id]=match; this.store.save(); this.ensureControllers(match); return this.get(owner,match.id);
  }
  start(owner,id) { const {match,side}=this.owned(owner,id); need(match.status==='active','拳赛已经结束',409); if(match.humans[side].status==='pending'){ match.humans[side]=this.makeBout(5); this.ensureControllers(match); this.store.save(); } return this.get(owner,id); }
  input(owner,id,{action,seq}) {
    const {match,side}=this.owned(owner,id), bout=match.humans[side];
    need(match.status==='active' && bout.status==='running','本场真人战斗已结束',409);
    need(ACTIONS.includes(action) && Number.isSafeInteger(seq) && seq>0,'无效操作');
    if(seq>bout.seq){ bout.seq=seq; bout.input=action; bout.lastInputAt=this.now(); if(['jab','heavy'].includes(action))bout.pendingPunch={action,expiresAt:this.now()+500}; } return {ok:true,seq:bout.seq};
  }
  surrender(owner,id) { const {match,side}=this.owned(owner,id), bout=match.humans[side]; need(bout.status==='running','本场真人战斗已结束',409); finishBout(bout,1,'surrender'); this.settle(match); this.store.save(); return this.get(owner,id); }
  get(owner,id) {
    const {match,side}=this.owned(owner,id);
    const safe = bout => { const {input,lastInputAt,pendingPunch,...rest}=bout; return structuredClone(rest); };
    return {id:match.id,status:match.status,reason:match.reason,training:match.training,now:this.now(),side,petIds:match.petIds,
      pets:match.petIds.map(id=>this.cosmetic(id)), petBout:safe(match.petBout), human:safe(match.humans[side]), otherHumanStatus:match.humans[1-side].status,results:match.results};
  }
  ensureControllers(match) {
    const add = (bout,label,fighter) => {
      const key=`${match.id}:${label}:${fighter}`; if(this.controllers.has(key)||bout.status!=='running') return;
      const petSide=label==='pet'?fighter:1-Number(label.slice(5));
      const c={key,match,bout,fighter,skill:match._skills?.[petSide]||null,skillStatus:null,skillUntil:0,queue:[],command:'idle',until:0,pending:false,lastRequest:0,failures:0,controller:new AbortController()};
      this.controllers.set(key,c); this.request(c);
    };
    add(match.petBout,'pet',0); add(match.petBout,'pet',1);
    match.humans.forEach((bout,i)=>add(bout,`human${i}`,1));
  }
  request(c) {
    if(this.closed || c.pending || c.bout.status!=='running' || c.match.status!=='active') return;
    if (c.skill?.gameId === 'boxing' && boxingSkillDecision(c.skill, fighterObservation(c.bout,c.fighter)).choice !== null) return;
    if(this.brain.mode!=='model') return;
    c.pending=true; c.lastRequest=this.now();
    const task=(async()=>{
      try {
        const result=await this.brain.json([
          {role:'system',content:'Control a pixel boxing fighter. Return JSON {"actions":["advance","jab","retreat"]}, 1 to 3 actions, each lasts 0.5 seconds. Allowed: idle, advance, retreat, jab, heavy, guard. Idle means standing without blocking. Blocking requires choosing guard. Never output explanations. Arena width 800; fighters cannot pass each other. Walking speed 220 units/sec. Jab range 114, damage 8*power, startup 0.1s, total 0.4s. Heavy range 140, damage 16*power, startup 0.25s, total 0.8s. Guard reduces damage to 20 percent but cannot attack; retreat can avoid punches entirely. Current attacks finish before new attacks. Approach when far away. Alternate quick attacks and retreats at close distance; punish a heavy attack with a heavy counter or escape. Do not stand guarding forever. Timeout compares remaining HP percentage. You only see current visible state, no future player inputs.'},
          {role:'user',content:JSON.stringify(fighterObservation(c.bout,c.fighter))}
        ],{playEffort:'none',timeoutMs:5000,signal:c.controller.signal});
        if(!Array.isArray(result?.actions)||result.actions.length<1||result.actions.length>3||!result.actions.every(a=>ACTIONS.includes(a))) throw new Error('invalid boxing actions');
        if(this.closed || c.bout.status!=='running' || c.match.status!=='active') return;
        c.failures=0; c.queue.push(...result.actions); c.queue=c.queue.slice(0,4);
        c.bout.decisions[c.fighter]={source:'model',status:'ready',at:this.now(),calls:(c.bout.decisions[c.fighter]?.calls||0)+1,skillStatus:c.skillStatus};
      } catch {
        if(!this.closed && c.bout.status==='running' && !c.controller.signal.aborted) {
          c.failures++;
          if(c.failures>=3){c.match.status='void';c.match.reason='模型连续三次响应异常，本场作废，不计分';this.store.save();}
          c.bout.decisions[c.fighter]={source:'model',status:'unavailable',at:this.now(),calls:c.bout.decisions[c.fighter]?.calls||0};
        }
      } finally {c.pending=false;}
    })(); this.pending.add(task); task.finally(()=>this.pending.delete(task));
  }
  command(c) {
    if (c.skill?.gameId === 'boxing') {
      if(c.bout.frame>=c.skillUntil){
        const decision=boxingSkillDecision(c.skill,fighterObservation(c.bout,c.fighter));
        c.skillChoice=decision.choice;c.skillStatus=decision.status;c.skillUntil=c.bout.frame+BOXING.commandTicks;
      }
      if(c.skillChoice!==null && c.skillChoice!==undefined){
        c.bout.decisions[c.fighter]={source:'skill',status:'ready',skillStatus:c.skillStatus};
        return c.skillChoice;
      }
    }
    if(this.brain.mode==='algorithm') {
      c.bout.decisions[c.fighter]={source:'algorithm',status:'ready',skillStatus:c.skillStatus};
      const o=fighterObservation(c.bout,c.fighter), phase=Math.floor(c.bout.frame/12)%6;
      return o.distance>110?'advance':phase===0?'guard':phase===1?'retreat':phase===4?'heavy':'jab';
    }
    if(c.bout.frame>=c.until){ const next=c.queue.shift(); c.command=next||'idle'; c.until=c.bout.frame+(next?BOXING.commandTicks:4); }
    if(c.queue.length<2&&!c.pending&&this.now()-c.lastRequest>700) this.request(c);
    return c.command;
  }
  tick() {
    if(this.closed)return;
    let changed=false;
    for(const match of Object.values(this.s.boxingMatches)) {
      if(match.status!=='active')continue;
      if(this.now()>=match.expiresAt){match.status='void';match.reason='24 小时未完成，本场作废';this.store.save();continue;}
      this.ensureControllers(match);
      const run=(bout,label,human=false)=>{
        if(bout.status!=='running')return;
        const target=Math.min(900,Math.max(0,Math.floor((this.now()-bout.startedAt)/BOXING.tickMs)));
        while(bout.frame<target && bout.status==='running') {
          const c1=this.controllers.get(`${match.id}:${label}:1`);
          let first=human?(this.now()-bout.lastInputAt<1500?bout.input:'idle'):this.command(this.controllers.get(`${match.id}:${label}:0`));
          if(human && bout.pendingPunch && !bout.fighters[0].attack && !bout.fighters[0].stun){
            if(this.now()<=bout.pendingPunch.expiresAt)first=bout.pendingPunch.action;
            bout.pendingPunch=null;
          }
          stepBout(bout,[first,this.command(c1)]);changed=true;
        }
      };
      run(match.petBout,'pet'); match.humans.forEach((bout,i)=>run(bout,`human${i}`,true)); this.settle(match);
    }
    for(const [key,c] of this.controllers)if(c.match.status!=='active'||c.bout.status!=='running'){c.controller.abort();this.controllers.delete(key);}
    if(changed&&this.now()-this.lastSave>=500){this.store.save();this.lastSave=this.now();}
  }
  settle(match) {
    if(match.status!=='active'||!terminal(match.petBout)||!match.humans.every(b=>terminal(b)||b.status==='not_applicable'))return;
    const scores=match.petIds.map((id,i)=>{
      const pet=boxingScore(match.petBout,i), human=terminal(match.humans[i])?boxingScore(match.humans[i],0):null;
      return {pet,human,score:pet.score+(human?.score||0),rankMs:pet.rankMs+(human?.rankMs||0)};
    });
    const diff=scores[0].score-scores[1].score||scores[1].rankMs-scores[0].rankMs;
    match.results={sides:scores,winner:diff===0?null:diff>0?0:1}; match.status='done';match.finishedAt=this.now();
    if(!match.training)match.petIds.forEach((id,i)=>{const pet=this.s.pets[id];pet.boxingRank??={score:0,rankMs:0,played:0,wins:0};pet.boxingRank.score+=scores[i].score;pet.boxingRank.rankMs+=scores[i].rankMs;pet.boxingRank.played++;if(match.results.winner===i)pet.boxingRank.wins++;});
    this.store.save();
  }
  async close(){this.closed=true;clearInterval(this.timer);for(const c of this.controllers.values())c.controller.abort();await Promise.allSettled([...this.pending]);this.store.save();}
}
