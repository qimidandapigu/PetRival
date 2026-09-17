import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as engine from '../public/jump-world.mjs';
import * as lab from '../public/jump-lab.mjs';
import * as jumpStages from '../public/jump-stages.mjs';
import {defaultAppearance,validateAppearance,petDisplayName} from '../shared/pet.mjs';
async function fixture(level){
 const nodes=new Map(),events=new Map(),saved=new Map(),requests=[];let resolveDecision;
 const element=tag=>({tagName:tag,className:'',textContent:'',dataset:{},children:[],disabled:false,attributes:{},addEventListener(t,h){this[t]=h;},setAttribute(k,v){this.attributes[k]=v;},append(...kids){this.children.push(...kids);},replaceChildren(...kids){this.children=kids;},closest(){return null;}});
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#camera'?'human':'',hidden:true,disabled:false,checked:false,textContent:'',dataset:{},addEventListener(t,h){this[t]=h;},focus(){},closest(){return null;},getContext(){return {};},clientWidth:900,replaceChildren(...kids){this.children=kids;}});return nodes.get(id);};
 const context=vm.createContext({...engine,...lab,...jumpStages,stageLevel:id=>level||jumpStages.stageLevel(id),freshProgress:engine.progress,defaultAppearance,validateAppearance,petDisplayName,AbortSignal,AbortController,crypto,
 document:{querySelector:node,querySelectorAll:()=>[],createElement:element,addEventListener:(t,h)=>events.set(t,h)},window:{addEventListener(){}},requestAnimationFrame(){},
 localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},fetch:async(path,opts)=>{
 if(path==='/api/jump/decision'){requests.push(JSON.parse(opts.body));return new Promise(r=>{resolveDecision=data=>r({ok:true,json:async()=>data});});}
 if(path==='/api/jump/lesson/learn')return {ok:true,json:async()=>({method:'model',model:'fixture',knowledge:[{id:'r1',claim:'x=560 前必须起跳',state:'确认',evidence:['a','b','c']}],learned:1,confirmed:1,adjusted:[],note:'',latencyMs:5})};
 return {ok:true,json:async()=>({mine:{id:'p',name:'小精灵',species:'xiaotangyuan'}})};
 }});
 const source=readFileSync(new URL('../public/jump.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'');
 vm.runInContext(source+'\nthis.fixture={advance,start,teach,finishDemo,resetLevel,learnLesson,get:()=>({human,pet,progress,samples,pending,queue,enabled,prefetched,falls})};',context);
 await new Promise(r=>setImmediate(r));return {api:context.fixture,node,saved,requests,key:(type,code)=>events.get(type)({code,target:node('#jump-canvas'),preventDefault(){}}),resolve:data=>resolveDecision(data)};
}
const result={method:'model',model:'fixture',latencyMs:10,actions:[{move:1,jump:false,frames:10}],goal:'走向高台',usedDemonstrations:[],demonstrationsProvided:0};
test('human remains movable during model wait and reset discards stale actions',async()=>{
 const f=await fixture();f.api.start();assert.equal(f.api.get().pending,true);f.key('keydown','ArrowRight');for(let i=0;i<20;i++)f.api.advance();
 assert.ok(f.api.get().human.x>80);assert.equal(f.api.get().pet.x,48,'the pet waits at the stage spawn');
 assert.equal(f.api.get().progress.coins.length,0);
 f.api.resetLevel();f.resolve(result);await new Promise(r=>setImmediate(r));assert.equal(f.api.get().queue.length,0);assert.equal(f.api.get().enabled,false);
});
test('recorded human actions are sent to model and only returned actions drive pet',async()=>{
 const f=await fixture();f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<20;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 assert.equal(f.api.get().samples.length,1);assert.equal(f.api.get().pet.x,48);
 assert.equal(JSON.parse(f.saved.get('petrival.jump.v2.pet.p'))[0].actions[0].frames,20);
 f.api.start();assert.equal(f.requests[0].demonstrations.length,1);f.resolve(result);await new Promise(r=>setImmediate(r));
 for(let i=0;i<10;i++)f.api.advance();assert.ok(Math.abs(f.api.get().pet.x-80)<.001);
});
test('a reflection distils demonstrations: decisions stop shipping the raw recording',async()=>{
 const f=await fixture();f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<20;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 assert.equal(f.api.get().samples.length,1);
 await f.api.learnLesson();await new Promise(r=>setImmediate(r));
 assert.equal(f.api.get().samples[0].distilled,true,'the recording is marked as distilled');
 f.api.start();await new Promise(r=>setImmediate(r));
 assert.equal(f.requests[0].demonstrations.length,0,'distilled demos leave the decision context — the rules speak for them');
});
test('death prefetch: a fatal segment is pre-planned from the respawn and adopted on revival',async()=>{
 const f=await fixture(jumpStages.stageLevel(2));f.api.start();await new Promise(r=>setImmediate(r));
 const fatal={...result,actions:[{move:1,jump:false,frames:90},{move:1,jump:false,frames:90},{move:1,jump:false,frames:90},{move:1,jump:false,frames:90}]};
 f.resolve(fatal);await new Promise(r=>setImmediate(r));
 for(let i=0;i<5;i++)f.api.advance();await new Promise(r=>setImmediate(r));
 assert.equal(f.requests.length,2,'the engine foresaw the fall and prefetched during playback');
 assert.equal(f.requests[1].actor.x,48,'the prefetched plan starts at the respawn, not at the cliff');
 assert.deepEqual(f.requests[1].progress,{coins:[],key:false,switchOn:false,won:false},'respawn progress is fresh');
 f.resolve({...result,actions:[{move:1,jump:false,frames:30}]});await new Promise(r=>setImmediate(r));
 assert.equal(f.api.get().prefetched.afterDeath,true);
 for(let i=0;i<400;i++)f.api.advance();
 assert.equal(f.api.get().falls,1,'the foreseen fall still happened and was recorded');
 assert.equal(f.requests.length,3,'the respawn needed no live decision — the adopted plan simply chained another prefetch');
 assert.ok(f.api.get().pet.x>64,'the respawned pet is executing the prefetched plan');
});
