import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './support.mjs';
import { transaction, CloudStore } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain, executeJob } from '../cloud/brain.mjs';
import { recordVerifiedClear } from '../shared/progression.mjs';
import { replay } from '../shared/game.mjs';

test('D1 persists unlocks/settings, snapshots generation jobs, and replaces only verified future boards', async () => {
 const db=database(),brain=makeBrain({AI_MODE:'algorithm'});
 const act=fn=>transaction(db,store=>fn(new CloudArena(store,brain),store));
 const pet=await act(a=>a.createPet('mastery-owner',{name:'测试宠物',species:'sprout',defense:true}));
 let claim=await act(a=>a.claimJob('preparation'));
 if(!claim)claim=await act(a=>a.claimJob());
 await act(a=>a.finishJob(claim,{rows:a.s.levels[pet.readyId].rows,proof:a.s.levels[pet.readyId].proof,method:'algorithm'}));
 await assert.rejects(act(a=>a.prepare(a.mine('mastery-owner'),'',{size:10,boxes:4})),/未解锁/);
 const old=await act(a=>{const p=a.mine('mastery-owner');for(let i=0;i<10;i++)recordVerifiedClear(p,`verified-fixture-${i}`,Date.now());a.prepare(p,'困难',{size:10,boxes:4,difficulty:'hard'});return p.readyId;});
 const loaded=await CloudStore.load(db);assert.equal(loaded.state.pets[pet.id].puzzleSettings.size,10);
 claim=await act(a=>a.claimJob());assert.equal(claim.config.boxes,4);
 // Deterministic seed belongs to this test double, never alters production player data.
 const result=await executeJob(brain,{...claim,seed:0});
 assert.equal(replay(result.rows,result.proof).won,true);
 await act(a=>a.finishJob(claim,result));
 await act(a=>{const p=a.mine('mastery-owner');assert.notEqual(p.readyId,old);assert.equal(a.s.levels[old].rows.length,8);assert.equal(a.s.levels[p.readyId].rows.length,10);assert.equal(a.publicPet(p).puzzleMastery.level,3);assert.equal(JSON.stringify(a.publicPet(p)).includes('proof'),false);});
});
