import test from 'node:test';
import assert from 'node:assert/strict';
import {starterLevel,actor,progress,step,touch,replayActions,verifyLevel,validateActions,validateLevel} from '../public/jump-world.mjs';
import {planJump,generateJump} from '../server/jump-model.mjs';
const fake = fn => ({mode:'model',info:()=>({model:'fixture-model'}),json:fn});
test('both players run the same rules on their own score, and the witness replays for either',()=>{
 const level=starterLevel(), proof=verifyLevel(level);assert.equal(proof.verified,true);
 assert.equal(replayActions(level,actor(level.spawn),progress(),proof.actions).progress.won,true);
 // The human is a full player now: same witness, same rules, its own progress object.
 const human=replayActions(level,actor(level.spawn),progress(),proof.actions,'human');
 assert.equal(human.progress.won,true);
 assert.deepEqual(human.progress.coins,progress().coins.concat([0,1,2]));
 const petProgress=progress();
 touch(actor({x:level.coins[0].x,y:level.coins[0].y+12}),'human',level,human.progress);
 assert.equal(human.progress.coins.includes(0),true);
 assert.deepEqual(petProgress,progress(),'the human must not touch the pet score');
 const p=progress(), a=actor({x:914,y:400});for(let i=0;i<10;i++)step(a,{move:1,jump:false},level,p);assert.equal(a.x,914);
 p.key=true;touch(actor({x:176,y:400}),'pet',level,p);assert.equal(p.switchOn,true);step(a,{move:1,jump:false},level,p);assert.ok(a.x>914);
 step(a,{move:1,jump:false},level,p);assert.equal(p.won,false,'the pet door opens only for the pet progress that carries the key');
});
test('unreachable key is rejected by bounded search; malformed actions cannot teleport',()=>{
 const l=starterLevel();l.key={x:1100,y:80};assert.equal(verifyLevel(l).verified,false);
 assert.throws(()=>validateActions([{move:9,jump:false,frames:1}]));assert.throws(()=>validateActions([{move:1,jump:false,frames:900}]));
 assert.throws(()=>validateLevel({...l,width:Infinity}));
});
test('model sees demonstrations, outputs actual actions, gets no generation witness',async()=>{
 const level=starterLevel(), a=actor(level.spawn), actions=[{move:1,jump:false,frames:20}];let observed;
 const d={id:'my-demo',level,from:a,to:{...a,x:128},actions,outcome:'survived'};
 const brain=fake(async messages=>{observed=JSON.parse(messages[1].content);return {actions,goal:'前往高台',usedDemonstrations:['my-demo','invented']};});
 const r=await planJump(brain,{level,actor:a,progress:progress(),demonstrations:[d]});
 assert.deepEqual(r.actions,actions);assert.equal(r.method,'model');assert.deepEqual(r.usedDemonstrations,['my-demo']);
 assert.deepEqual(observed.demonstrations[0].actions,actions);assert.equal(observed.level.actions,undefined);assert.equal(observed.solution,undefined);
 await assert.rejects(planJump({...brain,mode:'algorithm'},{level}),/未连接真实大模型/);
 await assert.rejects(planJump(fake(async()=>({actions:[{move:2,jump:false,frames:1}]})),{level,actor:a,progress:progress()}),/无效动作/);
});
test('model generation repairs an unverified candidate and returns no proof actions',async()=>{
 let calls=0;const bad=starterLevel();bad.key={x:1100,y:80};
 const result=await generateJump(fake(async()=>++calls===1?bad:starterLevel()),{});
 assert.equal(calls,2);assert.equal(result.verification.verified,true);assert.equal(result.verification.actions,undefined);assert.equal(result.source,'model');
 await assert.rejects(generateJump(fake(async()=>bad),{}),/未通过完整物理验证/);
});
