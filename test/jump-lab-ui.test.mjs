import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as engine from '../public/jump-world.mjs';
import * as lab from '../public/jump-lab.mjs';
import {defaultAppearance,validateAppearance,petDisplayName} from '../shared/pet.mjs';
const flush = () => new Promise(r => setImmediate(r));
test('every element the jump page drives exists in jump.html',()=>{
 const html=readFileSync(new URL('../public/jump.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../public/jump.mjs',import.meta.url),'utf8');
 const ids=[...source.matchAll(/\$\('#([\w-]+)'\)/g)].map(m=>m[1]);
 assert.ok(ids.length>12);
 for(const id of new Set(ids))assert.ok(html.includes(`id="${id}"`),`jump.html is missing #${id}`);
 for(const asset of ['/jump.mjs','/jump.css'])assert.ok(html.includes(asset),`jump.html must load ${asset}`);
 for(const module of ['./jump-world.mjs','./jump-lab.mjs'])assert.ok(source.includes(`from '${module}'`),`jump.mjs must import ${module}`);
});
async function fixture(){
 const nodes=new Map(),events=new Map(),saved=new Map(),waiting=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#camera'?'human':'',hidden:true,disabled:false,textContent:'',dataset:{},addEventListener(t,h){this[t]=h;},focus(){},closest(){return null;},getContext(){return {};},clientWidth:900});return nodes.get(id);};
 const answer=(path,data)=>{const queue=waiting.get(path);assert.ok(queue&&queue.length,`no pending ${path}`);queue.shift()({ok:true,status:200,json:async()=>data});};
 const context=vm.createContext({...engine,...lab,freshProgress:engine.progress,defaultAppearance,validateAppearance,petDisplayName,AbortSignal,AbortController,crypto,
 document:{querySelector:node,querySelectorAll:()=>[],addEventListener:(t,h)=>events.set(t,h)},window:{addEventListener(){}},requestAnimationFrame(){},
 localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},fetch:(path,opts)=>{
   if(path==='/api/session'||path==='/api/state')return Promise.resolve({ok:true,json:async()=>({mine:{id:'p',name:'小精灵',species:'xiaotangyuan'}})});
   return new Promise(resolve=>{const queue=waiting.get(path)||[];queue.push(resolve);waiting.set(path,queue);queue.body=JSON.parse(opts.body);});
 }});
 const source=readFileSync(new URL('../public/jump.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'');
 vm.runInContext(source+'\nthis.fixture={advance,start,teach,finishDemo,nextWorld,labBattery,labInduce,labPrior,labReveal,labWriteModel,labRunModelPlan,get:()=>({human,pet,progress,samples,queue,enabled,pending,mode,lab,level,status})};',context);
 await flush();
 return {api:context.fixture,saved,waiting,answer,body:path=>waiting.get(path).body,key:(type,code)=>events.get(type)({code,target:node('#jump-canvas'),preventDefault(){}})};
}
test('a blank world starts with nothing: no notebook, no traces, and the battery is free',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 let s=f.api.get();
 assert.equal(s.mode,'lab');assert.equal(s.lab.notebook.length,0);assert.equal(s.lab.traces.length,0);
 assert.deepEqual(s.level,s.lab.world.level);assert.equal(s.level.title,'空白的第一个世界');
 f.api.labBattery();s=f.api.get();
 assert.equal(s.lab.traces.filter(t=>t.origin==='engine').length,9);
 assert.equal(f.waiting.size,0,'the battery must not call the model');
 assert.ok(f.saved.has('petrival.jump.lab.v1.pet.p'));
 assert.equal(JSON.parse(f.saved.get('petrival.jump.lab.v1.pet.p')).seed,s.lab.seed);
});
test('induction goes through the server and the stored notebook is the server answer',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});f.api.labBattery();
 const pending=f.api.labInduce();
 assert.equal(f.body('/api/jump/lab/induce').traces.length,9);
 assert.equal(JSON.stringify(f.body('/api/jump/lab/induce')).includes('"physics"'),false);
 assert.equal(JSON.stringify(f.body('/api/jump/lab/induce')).includes('mapping'),false);
 f.answer('/api/jump/lab/induce',{method:'model',model:'fixture',notebook:[{id:'n1',claim:'按住 a 让精灵向右移动',state:'确认',evidence:['eng-a-hold','eng-a-tap','eng-ab-hold'],confidence:.9}],confirmed:1,learned:1,adjusted:['自报观察但证据 3 条，按证据记为确认'],nextExperiment:[{a:true,b:false,c:false,frames:20}],experiments:9,latencyMs:12});
 await pending;
 const s=f.api.get();
 assert.equal(s.lab.notebook.length,1);assert.equal(s.lab.notebook[0].state,'确认');assert.equal(s.lab.calls,1);
 assert.equal(s.lab.adjusted.length,1);assert.match(s.status,/归纳出 1 条新结论/);
});
test('a human demonstration in the lab becomes a labelled experiment, not a classic clip',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<20;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 const s=f.api.get(),human=s.lab.traces.filter(t=>t.origin==='human');
 assert.equal(s.samples.length,0);
 assert.equal(human.length,1);
 assert.equal(human[0].segments.reduce((n,x)=>n+x.frames,0),20);
 const right=Object.keys(s.lab.world.mapping).find(c=>s.lab.world.mapping[c]==='right');
 assert.equal(human[0].segments[0][right],true);
 assert.equal(human[0].segments[0].frames,20);
 assert.ok(human[0].delta.x>0);
});
test('the blank pet is given geometry, state and its own notebook only',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});f.api.labBattery();
 const induction=f.api.labInduce();
 f.answer('/api/jump/lab/induce',{method:'model',model:'fixture',notebook:[{id:'n1',claim:'c 通道让精灵离地',state:'观察',evidence:['eng-c-hold'],confidence:.5}],confirmed:0,learned:1,adjusted:[],nextExperiment:null,experiments:9,latencyMs:9});
 await induction;
 f.api.start();
 const payload=f.body('/api/jump/lab/plan');
 assert.equal(payload.demonstrations,undefined);assert.equal(payload.level,undefined);
 assert.equal(payload.notebook.length,1);assert.equal(typeof payload.actor.x,'number');
 for(const leak of ['mapping','physics','speed','gravity'])assert.equal(JSON.stringify(payload).includes(leak),false,leak);
 f.answer('/api/jump/lab/plan',{method:'model',model:'fixture',actions:[{a:false,b:false,c:true,frames:10}],prediction:{dy:'up',grounded:false,dead:false},goal:'试探 c',usedNotes:['n1'],notesProvided:1,unconfirmed:1,latencyMs:5});
 await flush();
 assert.equal(f.api.get().queue.length,1);
 for(let i=0;i<10;i++)f.api.advance();
 const s=f.api.get();
 assert.equal(s.queue.length,0);
 assert.equal(s.lab.accuracy.total,3,'the prediction is scored against the real engine');
 if(s.lab.world.mapping.c==='jump')assert.ok(s.pet.y<400||s.pet.vy<0);else assert.notEqual(s.pet.x,64);
 assert.equal(s.samples.length,0);
});
test('a new world keeps confirmed rules as unchecked hypotheses and records the curve',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});f.api.labBattery();
 const induction=f.api.labInduce();
 f.answer('/api/jump/lab/induce',{method:'model',model:'fixture',notebook:[{id:'n1',claim:'a 通道让精灵向右',state:'确认',evidence:['x','y','z'],confidence:.9}],confirmed:1,learned:1,adjusted:[],nextExperiment:null,experiments:3,latencyMs:4});
 await induction;
 f.api.nextWorld();
 const s=f.api.get();
 assert.equal(s.lab.index,2);assert.equal(s.lab.notebook.length,1);
 assert.equal(s.lab.notebook[0].state,'猜想');assert.equal(s.lab.notebook[0].evidence.length,0);
 assert.equal(s.lab.traces.length,0);assert.equal(s.lab.stats.length,1);assert.equal(s.lab.stats[0].index,1);
 assert.notEqual(s.lab.seed,1);
 const truth=lab.hiddenTruth(s.lab.world);f.api.labReveal();
 const revealed=f.api.get();
 assert.deepEqual(revealed.lab.answer.mapping,truth.mapping);
});
test('the world-model button sends traces, stores the code, and the real engine grades its plan',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});f.api.labBattery();
 const pending=f.api.labWriteModel();
 const payload=f.body('/api/jump/lab/model');
 assert.equal(payload.traces.length,9);
 assert.equal(typeof payload.planTo,'number');
 assert.equal(payload.planTo,lab.LAB_PLAN_TARGET);
 for(const leak of ['mapping','physics','gravity'])assert.equal(JSON.stringify(payload).includes(leak),false,leak);
 f.answer('/api/jump/lab/model',{method:'model',model:'fixture',code:'function step(s, a, level) { return s; }',verified:true,attempts:2,
   matched:132,frames:132,error:0,worst:0,died:false,mismatches:[],notes:'每帧位移 2.93',failure:'',
   plan:[{a:false,b:false,c:true,frames:30}],predicted:{x:152,y:400,vy:0,grounded:true,frames:30},planTo:520,planProblem:'',latencyMs:9});
 await pending;
 const s=f.api.get();
 assert.equal(s.lab.worldModel.verified,true);assert.equal(s.lab.worldModel.attempts,2);
 assert.equal(s.lab.worldModel.code.includes('function step'),true);
 assert.equal(s.lab.plan.actions.length,1);assert.equal(s.lab.plan.predicted.x,152);
 f.api.labRunModelPlan();
 assert.equal(f.api.get().queue.length,1);
 for(let i=0;i<30;i++)f.api.advance();
 const after=f.api.get();
 assert.equal(after.queue.length,0);
 assert.equal(after.lab.modelRuns.length,1);
 assert.equal(after.lab.traces.filter(t=>t.origin==='self').length,1);
 assert.equal(JSON.parse(f.saved.get('petrival.jump.lab.v1.pet.p')).worldModel.verified,true);
});
