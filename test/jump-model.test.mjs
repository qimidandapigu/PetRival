import test from 'node:test';
import assert from 'node:assert/strict';
import {starterLevel,actor,progress,step,touch,replayActions,verifyLevel,validateActions,validateLevel} from '../public/jump-world.mjs';
import {planJump,generateJump,learnJumpLesson} from '../server/jump-model.mjs';
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
test('the lesson model is shown a screen, not a blueprint, and is not told how to win',async()=>{
 const level=starterLevel(),a=actor(level.spawn);let messages;
 const brain={mode:'model',info:()=>({model:'fixture-model'}),json:async m=>{messages=m;return {actions:[{move:1,jump:false,frames:20}],goal:'往右走',plan:'先走到坑边再跳'};}};
 const result=await planJump(brain,{level,actor:a,progress:progress(),
   attempts:[{from:a,to:{...a,x:a.x+60},outcome:'fell',actions:[{move:1,jump:false,frames:20}]}],
   knowledge:[{id:'n1',claim:'96 像素的空隙要按住跳 30 帧以上',state:'确认',evidence:['a','b','c']}]});
 assert.equal(result.plan,'先走到坑边再跳');
 const system=messages[0].content,user=JSON.parse(messages[1].content);
 assert.equal(/speed|gravity|"jump":/.test(system),false,'no physics constants are handed over');
 assert.equal(system.includes('先取钥匙'),false,'no walkthrough order');
 assert.equal(system.includes('坑边前停下'),false,'no stop-at-the-edge instruction');
 assert.equal(system.includes('让 progress.won 变成 true'),true,'the only stated goal is to win');
 assert.equal(system.includes('# 地面或平台'),true,'the legend explains the screen symbols');
 assert.ok(user.screen.rows.length>=20,'the screen is a grid of rows');
 assert.equal(user.screen.rows.some(r=>r.includes('@')),true,'the pet is drawn on it');
 assert.equal(user.attempts.length,1,'its own failed attempt is in the context');
 assert.equal(user.knowledge.length,1,'its summarised knowledge is in the context');
 assert.equal(user.level,undefined,'the rectangle blueprint is gone');
 await assert.rejects(learnJumpLesson(brain,{level}),/还没有可以总结的尝试或示范/);
 const learned=await learnJumpLesson(brain,{level,attempts:[{from:a,to:{...a,x:a.x+60},outcome:'fell',actions:[{move:1,jump:false,frames:20}]}],
   knowledge:[{id:'n1',claim:'x=400 处会掉下去',state:'猜想',evidence:[]}]});
 assert.equal(learned.attempts,1);
});
test('episodic cards: older attempts keep a summary, only the last two keep raw actions',async()=>{
 const level=starterLevel(),a=actor(level.spawn);let user;
 const mk=i=>({id:`attempt-${i}`,from:a,to:{...a,x:a.x+40},outcome:'fell',actions:[{move:1,jump:false,frames:20},{move:1,jump:true,frames:30}]});
 const brain=fake(async messages=>{user=JSON.parse(messages[1].content);return {actions:[{move:1,jump:false,frames:20}]};});
 await planJump(brain,{level,actor:a,progress:progress(),attempts:[mk(1),mk(2),mk(3),mk(4)]});
 assert.equal(user.attempts.length,4);
 assert.equal(user.attempts[0].actions,undefined,'old attempts ship no raw action JSON');
 assert.equal(user.attempts[1].actions,undefined);
 assert.equal(user.attempts[0].summary,'右20帧→右跳30帧','the summary still says what was tried');
 assert.deepEqual(user.attempts[2].actions,[{move:1,jump:false,frames:20},{move:1,jump:true,frames:30}],'recent attempts keep raw actions');
 assert.deepEqual(user.attempts[3].actions,[{move:1,jump:false,frames:20},{move:1,jump:true,frames:30}]);
 assert.equal(user.attempts[0].outcome,'fell');
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
 assert.deepEqual(observed.demonstrations[0].actions,actions);
 assert.equal(observed.level,undefined,'the level is a screen now, not a rectangle list');
 assert.ok(observed.screen.rows.length>10);assert.equal(observed.attempts.length,0);assert.equal(observed.solution,undefined);
 await assert.rejects(planJump({...brain,mode:'algorithm'},{level}),/未连接真实大模型/);
 await assert.rejects(planJump(fake(async()=>({actions:[{move:2,jump:false,frames:1}]})),{level,actor:a,progress:progress()}),/无效动作/);
});
test('model generation repairs an unverified candidate and returns no proof actions',async()=>{
 let calls=0;const bad=starterLevel();bad.key={x:1100,y:80};
 const result=await generateJump(fake(async()=>++calls===1?bad:starterLevel()),{});
 assert.equal(calls,2);assert.equal(result.verification.verified,true);assert.equal(result.verification.actions,undefined);assert.equal(result.source,'model');
 await assert.rejects(generateJump(fake(async()=>bad),{}),/未通过完整物理验证/);
});
