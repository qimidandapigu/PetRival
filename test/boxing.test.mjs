import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newBout, stepBout, finishBout, boxingScore, fighterObservation } from '../shared/boxing.mjs';
import { createApp } from '../server/http.mjs';
import { BoxingArena } from '../server/boxing-arena.mjs';
const near=b=>{b.fighters[0].x=350;b.fighters[1].x=440;return b;};
const frames=(b,n,inputs)=>{for(let i=0;i<n;i++)stepBout(b,inputs);return b;};
test('human opponent has exactly five times HP and damage, pet lane remains normal and independent',()=>{
  const pet=near(newBout()),human=near(newBout(5));
  frames(pet,2,['advance','jab']);frames(human,2,['advance','jab']);
  assert.equal(pet.fighters[0].hp,22);assert.equal(human.fighters[0].hp,0);
  assert.equal(pet.fighters[1].maxHp,30);assert.equal(human.fighters[1].maxHp,150);
  assert.equal(pet.events.find(e=>e.type==='hit').damage,8);assert.equal(human.events.find(e=>e.type==='hit').damage,40);
  assert.equal(human.fighters[0].maxHp,30);assert.equal(human.fighters[0].power,1);
});
test('range, windup, blocking and recovery prevent instant or unlimited hits',()=>{
  const b=near(newBout());stepBout(b,['heavy','guard']);assert.equal(b.fighters[1].hp,30);
  frames(b,4,['heavy','guard']);assert.equal(b.fighters[1].hp,26);
  frames(b,8,['heavy','guard']);assert.equal(b.fighters[1].hp,26);
  const far=newBout();frames(far,20,['heavy','jab']);assert.deepEqual(far.fighters.map(f=>f.hp),[30,30]);
});
test('simultaneous lethal punches draw and terminal bouts never change',()=>{
  const b=near(newBout());b.fighters.forEach(f=>f.hp=8);frames(b,2,['jab','jab']);
  assert.equal(b.status,'done');assert.equal(b.winner,null);const done=JSON.stringify(b);frames(b,20,['jab','heavy']);assert.equal(JSON.stringify(b),done);
});
test('timeout compares HP percentage, surrender and losing time never create fast-loss advantage',()=>{
  const b=newBout(5);b.fighters[0].hp=24;b.fighters[1].hp=90;b.frame=899;stepBout(b,['guard','guard']);
  assert.equal(b.winner,0);assert.equal(b.endMs,45000);
  const loss=newBout();finishBout(loss,1,'surrender');assert.deepEqual(boxingScore(loss,0),{score:-20,rankMs:45000});
});
test('fighters cannot cross or escape the ring; observations contain no future inputs',()=>{
  const b=newBout();frames(b,60,['advance','advance']);assert.ok(b.fighters[1].x-b.fighters[0].x>=82);
  frames(b,100,['retreat','retreat']);assert.equal(b.fighters[0].x,55);assert.equal(b.fighters[1].x,745);
  const observation=fighterObservation(b,0);assert.equal('input' in observation.opponent,false);assert.equal('queue' in observation.opponent,false);
});
async function fixture(t,env={AI_MODE:'algorithm'}){
  let now=10000;const app=createApp({dataDir:mkdtempSync(join(tmpdir(),'boxing-test-')),env,now:()=>now});
  t.after(()=>app.close());return {...app,advance:ms=>{now+=ms;app.boxing.tick();}};
}
async function pets(f){const a=f.arena.session().owner,b=f.arena.session().owner,c=f.arena.session().owner;const me=f.arena.createPet(a,{name:'A',species:'fox',defense:true});const rival=f.arena.createPet(b,{name:'B',species:'ghost',defense:true});await f.arena.idle();return{a,b,c,me,rival};}
test('parallel bouts, opponent ownership, monotonic inputs, disconnect lease and exactly-once team ranking',async t=>{
  const f=await fixture(t),{a,b,c,me,rival}=await pets(f);const m=f.boxing.create(a,rival.id),stored=f.arena.s.boxingMatches[m.id];
  assert.equal(m.human.startedAt,m.petBout.startedAt);assert.equal(f.boxing.create(a,rival.id).id,m.id);
  assert.throws(()=>f.boxing.input(c,m.id,{action:'jab',seq:1}),/无权/);
  assert.throws(()=>f.boxing.input(a,m.id,{action:'WIN',seq:1}),/无效/);
  f.boxing.input(a,m.id,{action:'advance',seq:2});f.boxing.input(a,m.id,{action:'heavy',seq:1});assert.equal(stored.humans[0].input,'advance');
  f.advance(2500);assert.equal(stored.humans[0].fighters[0].action,'idle','stale held input expires');
  assert.ok(stored.petBout.frame>0&&stored.humans[0].frame>0);assert.equal(stored.humans[1].status,'pending');
  assert.equal(f.boxing.get(b,m.id).human.status,'pending');f.boxing.start(b,m.id);
  finishBout(stored.petBout,0);finishBout(stored.humans[0],0);finishBout(stored.humans[1],1);f.boxing.tick();f.boxing.tick();
  assert.equal(stored.status,'done');assert.equal(me.boxingRank.score,200);assert.equal(rival.boxingRank.score,-40);assert.equal(me.boxingRank.played,1);assert.equal(me.score,0,'Sokoban ranking remains separate');
});
test('training has no fabricated opponent human and cannot change ranked scores',async t=>{
  const f=await fixture(t),{a,me}=await pets(f);const bot=Object.values(f.arena.s.pets).find(p=>p.bot);const m=f.boxing.create(a,bot.id),stored=f.arena.s.boxingMatches[m.id];
  assert.equal(stored.humans[1].status,'not_applicable');finishBout(stored.petBout,0);f.boxing.surrender(a,m.id);assert.equal(stored.status,'done');assert.equal(me.boxingRank,undefined);
});
test('real HTTP applies session ownership and does not trust client damage or outcomes',async t=>{
  const f=await fixture(t);await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${f.server.address().port}`;
  const {a,c,me,rival}=await pets(f);const token=Object.entries(f.arena.s.sessions);assert.ok(token.length);
  // Use issued cookies through production routing, never a caller-provided owner ID.
  const session=f.arena.session();f.arena.s.pets[me.id].owner=session.owner;
  const headers={cookie:`petrival=${session.token}`,'Content-Type':'application/json'};
  const res=await fetch(base+'/api/boxing',{method:'POST',headers,body:JSON.stringify({opponentId:rival.id})});assert.equal(res.status,201);const match=await res.json();
  const response=await fetch(base+`/api/boxing/${match.id}/input`,{method:'POST',headers,body:JSON.stringify({action:'jab',seq:1,hp:0,winner:0,damage:999})});assert.equal(response.status,200);
  assert.equal(f.arena.s.boxingMatches[match.id].humans[0].fighters[1].hp,150);
  const outsider=f.arena.session();const denied=await fetch(base+`/api/boxing/${match.id}`,{headers:{cookie:`petrival=${outsider.token}`}});assert.equal(denied.status,404);
  const html=await(await fetch(base+'/boxing')).text();assert.ok(html.includes('pet-ring')&&html.includes('human-ring'));
});
test('model receives visible state only, disabled thinking, bounded action queue; repeated errors void without penalty',async t=>{
  const f=await fixture(t);const {a,me,rival}=await pets(f);f.brain.mode='model';let calls=0;
  f.brain.json=async(messages,options)=>{calls++;assert.equal(options.playEffort,'none');assert.equal(options.timeoutMs,5000);const input=JSON.parse(messages[1].content);assert.equal('queue' in input,false);return {actions:['advance','jab','retreat']};};
  const m=f.boxing.create(a,rival.id);await Promise.allSettled([...f.boxing.pending]);assert.equal(calls,3);
  const c=[...f.boxing.controllers.values()][0];assert.deepEqual(c.queue,['advance','jab','retreat']);
  f.brain.json=async()=>{throw new Error('provider unavailable');};for(let i=0;i<3;i++){f.boxing.request(c);await Promise.allSettled([...f.boxing.pending]);}
  assert.equal(c.match.status,'void');assert.equal(me.boxingRank,undefined);assert.ok(c.match.reason.includes('不计分'));
});


test('a quick punch tap survives key release before the next physics tick',async t=>{
  const f=await fixture(t),{a,rival}=await pets(f);const m=f.boxing.create(a,rival.id),bout=f.arena.s.boxingMatches[m.id].humans[0];
  f.advance(2200);f.boxing.input(a,m.id,{action:'heavy',seq:1});f.boxing.input(a,m.id,{action:'idle',seq:2});f.advance(50);
  assert.equal(bout.fighters[0].action,'heavy');assert.equal(bout.fighters[0].attack.age,1);assert.equal(bout.pendingPunch,null);
});


test('runtime restart voids unfinished fighting rather than resetting the clock or awarding ranks',async t=>{
  const f=await fixture(t),{a,me,rival}=await pets(f);const m=f.boxing.create(a,rival.id);f.advance(3000);await f.boxing.close();
  const recovered=new BoxingArena(f.arena,f.brain,{autoTick:false});t.after(()=>recovered.close());
  assert.equal(recovered.get(a,m.id).status,'void');assert.equal(me.boxingRank,undefined);assert.equal(f.arena.s.boxingMatches[m.id].petBout.frame,16);
});


test('standing and released guard take full damage; only explicit guard reduces damage',()=>{
  const idle=near(newBout());assert.ok(idle.fighters.every(f=>f.action==='idle'));
  frames(idle,2,['idle','jab']);assert.equal(idle.fighters[0].hp,22);
  const guarded=near(newBout());frames(guarded,2,['guard','jab']);assert.equal(guarded.fighters[0].hp,28);
  frames(guarded,8,['idle','jab']);assert.equal(guarded.fighters[0].hp,20,'release returns to full damage on the next punch');
});
test('human guard is held explicitly and release or disconnected input returns to neutral',async t=>{
  const f=await fixture(t),{a,rival}=await pets(f);const m=f.boxing.create(a,rival.id),bout=f.arena.s.boxingMatches[m.id].humans[0];
  f.boxing.command=()=> 'idle';
  f.advance(2250);assert.equal(bout.fighters[0].action,'idle');
  f.boxing.input(a,m.id,{action:'guard',seq:1});f.advance(50);assert.equal(bout.fighters[0].action,'guard');
  f.boxing.input(a,m.id,{action:'idle',seq:2});f.advance(50);assert.equal(bout.fighters[0].action,'idle');
  f.boxing.input(a,m.id,{action:'guard',seq:3});f.advance(1600);assert.equal(bout.fighters[0].action,'idle');
});
