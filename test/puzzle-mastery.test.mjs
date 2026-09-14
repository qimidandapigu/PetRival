import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, parse, renderRows, replay, solve, analyzeSolution } from '../shared/game.mjs';
import { puzzleMasteryView, puzzleSettings, recordVerifiedClear } from '../shared/progression.mjs';
import { reachablePushes, stepObservation } from '../server/step-observation.mjs';
import { previewCandidates, validateStage } from '../server/push-preview.mjs';
import { PetBrain } from '../server/provider.mjs';
import { Arena } from '../server/arena.mjs';

const jobs = { run: async (task,d) => task === 'generate' ? generate(d.seed,d.intent,d.config) : solve(d.rows) };
test('mastery unlocks on verified unique clears, persists, and rejects forged settings', () => {
  const pet = {};
  assert.equal(puzzleMasteryView(pet).level,1);
  assert.throws(()=>puzzleSettings(pet,{size:10,boxes:4}));
  for(let i=0;i<3;i++)recordVerifiedClear(pet,`fixture-${i}`,i);
  recordVerifiedClear(pet,'fixture-0',4);
  assert.equal(puzzleMasteryView(pet).clears,3);
  assert.deepEqual(puzzleSettings(pet,{size:9,boxes:3}),{size:9,boxes:3,difficulty:'normal'});
  assert.throws(()=>puzzleSettings(pet,{size:10,boxes:3}));
  for(let i=3;i<10;i++)recordVerifiedClear(pet,`fixture-${i}`,i);
  const restored=JSON.parse(JSON.stringify(pet));
  assert.equal(puzzleMasteryView(restored).maxBoxes,4);
  assert.deepEqual(puzzleSettings(restored,{size:8,boxes:2}),{size:8,boxes:2,difficulty:'normal'});
  for(const settings of [{size:11},{boxes:5},{size:'10'},{difficulty:'extreme'}])assert.throws(()=>puzzleSettings(restored,settings));
});

test('8/9/10 boards round-trip, replay, and observations preserve all boxes and dimensions', () => {
  for(const [size,boxes] of [[8,2],[9,3],[10,4]]) {
    const g=generate(0,'困难',{size,boxes,difficulty:'hard'}), state=parse(g.rows);
    assert.equal(state.width,size);assert.equal(state.boxes.length,boxes);
    assert.deepEqual(renderRows(state),g.rows);assert.equal(replay(g.rows,g.proof).won,true);
    assert.deepEqual(generate(0,'困难',{size,boxes,difficulty:'hard'}),g);
    const observation=stepObservation(state,{turn:1,remainingMs:10000});
    assert.equal(observation.boxes.length,boxes);
    assert.deepEqual(observation.player,{x:state.player%size,y:Math.floor(state.player/size)});
    // Every actual solution push remains available and is never falsely marked a geometric deadlock.
    let current=state;
    while(!replay(renderRows(current),'').won) {
      const solution=solve(renderRows(current));assert.equal(solution.solved,true);
      const push=reachablePushes(current).find(c=>solution.actions.startsWith(c.actions));
      assert.ok(push);assert.equal(push.deadlock,false);
      const preview=previewCandidates(current,[{pushes:[push.id]}])[0];
      assert.equal(preview.error,null);
      current=replay(renderRows(current),push.actions).state;
    }
    assert.equal(solve(g.rows).pushes,analyzeSolution(g.rows,g.proof).pushes);
    assert.equal(solve(g.rows,1).reason,'budget');
  }
});

test('hard four-box sample requires at least fourteen actual pushes; walking is not difficulty', () => {
  const g=generate(0,'困难',{size:10,boxes:4,difficulty:'hard'});
  assert.equal(g.method,'algorithm');assert.ok(solve(g.rows).pushes>=14);
  assert.ok(g.quality.switches>=3);
  const s=parse(g.rows), box=s.boxes[3], goal=s.goals.find(g=>g!==box);
  assert.deepEqual(validateStage({box:{x:box%10,y:Math.floor(box/10)},target:{x:goal%10,y:Math.floor(goal/10)}},s)?.box,{x:box%10,y:Math.floor(box/10)});
});

test('model repairs wrong dimensions and too-easy boards using feedback, never silently downgrades', async () => {
  const brain=new PetBrain(jobs,{AI_MODE:'model',MODEL_API_KEY:'fixture',MODEL_NAME:'fixture'});
  const easy=['########','#      #','# .  . #','# $  $ #','#      #','#  @   #','#      #','########'];
  const good=generate(0,'困难',{size:8,boxes:2,difficulty:'hard'});let calls=0;
  brain.json=async messages=>{calls++;if(calls===2)assert.match(messages.at(-1).content,/推箱次数/);return {rows:calls===1?easy:good.rows};};
  const result=await brain.generate('困难',0,{size:8,boxes:2,difficulty:'hard'});
  assert.equal(calls,2);assert.equal(result.method,'model');assert.ok(result.quality.pushes>=8);
  brain.json=async()=>({rows:easy});
  await assert.rejects(brain.generate('',0,{size:9,boxes:3,difficulty:'normal'}),/大小或箱子/);
});

test('failed preparation retains old level and fixed match version; settings are snapshotted', async () => {
  let release, captured;
  const brain={generate:async (intent,seed,config)=>{captured=config;await new Promise(r=>release=r);throw Error('fixture failure');}};
  const store={state:{pets:{},levels:{},challenges:{},sessions:{}},save(){}};
  const arena=new Arena(store,brain),pet=Object.values(store.state.pets)[0], old=pet.readyId;
  assert.throws(()=>arena.prepare(pet,'',{size:10,boxes:4}));
  arena.prepare(pet,'困难',{size:8,boxes:2,difficulty:'hard'});
  await Promise.resolve();assert.equal(captured.difficulty,'hard');assert.equal(pet.readyId,old);
  release();await arena.idle();assert.equal(pet.readyId,old);assert.ok(pet.prepareError);
});
