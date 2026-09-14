import test from 'node:test';
import assert from 'node:assert/strict';
import { newBout, stepBout, fighterObservation, boxingInstructions } from '../shared/boxing.mjs';
const near=()=>{const b=newBout();b.fighters[0].x=350;b.fighters[1].x=440;return b;};
const run=(b,n,inputs)=>{for(let i=0;i<n;i++)stepBout(b,typeof inputs==='function'?inputs(b):inputs);};
test('blocking a heavy grants time to jab its recovery, with counter bonus',()=>{
 const b=near();run(b,7,['heavy','guard']);assert.equal(b.fighters[1].hp,30);assert.equal(b.events[0].type,'block');
 run(b,6,['heavy','jab']);assert.equal(b.fighters[0].hp,25);assert.ok(b.history.some(e=>e.type==='counter'));assert.equal(b.fighters[1].hp,30);
});
test('throw beats guard, jab interrupts throw and distance makes throw miss',()=>{
 const b=near();run(b,6,['throw','guard']);assert.equal(b.fighters[1].hp,26);assert.equal(b.events[0].type,'guardbreak');
 const c=near();run(c,6,['throw','jab']);assert.equal(c.fighters[0].hp,27);assert.equal(c.fighters[1].hp,30);
 const d=near();run(d,6,['throw','retreat']);assert.equal(d.fighters[1].hp,30);assert.ok(d.events.some(e=>e.type==='miss'));
});
test('whiffed heavy cannot cancel into guard; the exposed recovery can be punished',()=>{
 const b=near();b.fighters[1].x=500;run(b,8,['heavy','idle']);assert.ok(b.fighters[0].cue.message.includes('打空'));
 run(b,4,['guard','advance']);assert.equal(b.fighters[0].action,'heavy');run(b,2,['guard','jab']);assert.equal(b.fighters[0].hp,25);
});
test('repeated heavy has a counter strategy rather than beating block then jab',()=>{
 const b=near();run(b,900,b=>{
 const o=fighterObservation(b,1);
 return [o.distance>125?'advance':'heavy',o.opponent.recovering?(o.distance>112?'advance':'jab'):'guard'];
 });assert.equal(b.winner,1);assert.equal(b.fighters[1].hp,30);
});
test('observations expose bounded past actions and recovery, not queued future decisions',()=>{
 const b=near();run(b,100,['jab','guard']);b._controls={0:{queue:['throw']}};
 const o=fighterObservation(b,1);assert.ok(o.recent.length>0&&o.recent.length<=10);assert.ok(o.recent.every(e=>e.frame<=b.frame));assert.ok(!JSON.stringify(o).includes('queue'));assert.match(boxingInstructions(o),/Throw range102/);
});
test('old bouts retain original damage and chip; completed results remain immutable',()=>{
 const b=near();delete b.rulesVersion;run(b,2,['jab','guard']);assert.equal(b.fighters[1].hp,28);
 b.status='done';const saved=JSON.stringify(b);run(b,40,['throw','jab']);assert.equal(JSON.stringify(b),saved);
});

