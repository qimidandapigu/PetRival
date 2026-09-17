import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as engine from '../public/jump-world.mjs';
import * as lab from '../public/jump-lab.mjs';
import * as jumpStages from '../public/jump-stages.mjs';
import {defaultAppearance,validateAppearance,petDisplayName} from '../shared/pet.mjs';
const flush = () => new Promise(r => setImmediate(r));
test('every element the jump page drives exists in jump.html',()=>{
 const html=readFileSync(new URL('../public/jump.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../public/jump.mjs',import.meta.url),'utf8');
 const ids=[...source.matchAll(/\$\('#([\w-]+)'\)/g)].map(m=>m[1]);
 assert.ok(ids.length>12);
 for(const id of new Set(ids))assert.ok(html.includes(`id="${id}"`),`jump.html is missing #${id}`);
 for(const asset of ['/jump.mjs','/jump.css'])assert.ok(html.includes(asset),`jump.html must load ${asset}`);
 for(const module of ['./jump-world.mjs','./jump-lab.mjs','./jump-stages.mjs'])assert.ok(source.includes(`from '${module}'`),`jump.mjs must import ${module}`);
 // A module the page imports but the server does not serve is a blank page in the browser,
 // so every relative import has to appear in the Node file map.
 const server=readFileSync(new URL('../server/http.mjs',import.meta.url),'utf8');
 for(const imported of new Set([...source.matchAll(/from '\.\/([\w.-]+\.mjs)'/g)].map(m=>m[1])))
   assert.ok(server.includes(`'/public/${imported}'`)||server.includes(`'/${imported}'`),`server/http.mjs must serve /${imported}`);
});
async function fixture(){
 const nodes=new Map(),events=new Map(),saved=new Map(),waiting=new Map(),ops=[];
 const record=(()=>{let fill='';return {set fillStyle(v){fill=v;},get fillStyle(){return fill;},fillRect:(...a)=>ops.push(['fillRect',...a,fill]),save:()=>ops.push(['save']),restore:()=>ops.push(['restore']),
   beginPath:()=>ops.push(['beginPath']),rect:(...a)=>ops.push(['rect',...a]),clip:()=>ops.push(['clip']),
   translate:(...a)=>ops.push(['translate',...a]),fillText:(...a)=>ops.push(['fillText',...a])};})();
 const textOf=el=>String(el._text||'')+(el.children||[]).map(textOf).join('');
 const dom=(tag)=>{const el={tagName:tag,className:'',_text:'',dataset:{},children:[],disabled:false,attributes:{},
   get textContent(){return textOf(this);},set textContent(v){this._text=String(v);this.children=[];},
   addEventListener(t,h){this[t]=h;},setAttribute(k,v){this.attributes[k]=v;},append(...kids){this.children.push(...kids);},
   replaceChildren(...kids){this.children=kids;this._text='';},closest(sel){const attr=String(sel).replace(/[[\]]/g,''),key=attr.replace(/^data-/,'').replace(/-([a-z])/g,(m,c)=>c.toUpperCase());return this.dataset&&this.dataset[key]!==undefined?this:null;}};return el;};
 const node=id=>{if(!nodes.has(id))nodes.set(id,Object.assign(dom(id==='#jump-canvas'?'canvas':'div'),{value:id==='#camera'?'human':'',hidden:true,checked:false,focus(){},getContext(){return id==='#jump-canvas'?record:{};},clientWidth:900}));return nodes.get(id);};
 const answer=(path,data)=>{const queue=waiting.get(path);assert.ok(queue&&queue.length,`no pending ${path}`);queue.shift()({ok:true,status:200,json:async()=>data});};
 const context=vm.createContext({...engine,...lab,...jumpStages,freshProgress:engine.progress,defaultAppearance,validateAppearance,petDisplayName,AbortSignal,AbortController,crypto,
 document:{querySelector:node,querySelectorAll:()=>[],createElement:dom,addEventListener:(t,h)=>events.set(t,h)},window:{addEventListener(){}},requestAnimationFrame(){},
 localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},fetch:(path,opts)=>{
   if(path==='/api/session'||path==='/api/state')return Promise.resolve({ok:true,json:async()=>({mine:{id:'p',name:'小精灵',species:'xiaotangyuan'}})});
   if(path==='/api/log/client')return Promise.resolve({ok:true,json:async()=>({ok:true,stored:0})});
   return new Promise(resolve=>{const queue=waiting.get(path)||[];queue.push(resolve);waiting.set(path,queue);queue.body=JSON.parse(opts.body);});
 }});
 const source=readFileSync(new URL('../public/jump.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'');
 vm.runInContext(source+'\nthis.fixture={advance,start,teach,finishDemo,nextWorld,labBattery,labInduce,labPrior,labReveal,labWriteModel,labRunModelPlan,restartRound,goToStage,draw,fall:()=>{pet.dead=true;petRespawnAt=tick+45;},get:()=>({human,pet,progress,humanProgress,samples,queue,enabled,pending,mode,lab,level,status,splitView,roundIndex,roundDemos,tick,humanFalls,humanWon,stageId,clearedStages,petWins,humanWins,logFilter})};',context);
 await flush();
 return {api:context.fixture,saved,waiting,node,answer,ops,canvas:node('#jump-canvas'),body:path=>waiting.get(path).body,key:(type,code)=>events.get(type)({code,target:node('#jump-canvas'),preventDefault(){}})};
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
test('the learning log and the "what it knows" panel show every step in plain language',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 f.api.labBattery();
 const induction=f.api.labInduce();
 f.answer('/api/jump/lab/induce',{method:'model',model:'fixture',notebook:[
   {id:'n1',claim:'按住 a 让精灵向右移动',state:'确认',evidence:['e1','e2','e3'],confidence:.9},
   {id:'n2',claim:'空地落地时 vy 归零',state:'观察',evidence:['e1'],confidence:.5}],confirmed:1,learned:2,adjusted:[],nextExperiment:null,experiments:9,latencyMs:4200});
 await induction;
 const s=f.api.get();
 assert.equal(s.lab.log.some(e=>e.kind==='world'),true);
 assert.equal(s.lab.log.some(e=>e.kind==='battery'&&e.text.includes('0 次模型调用')),true);
 assert.equal(s.lab.log.some(e=>e.kind==='induce'&&e.text.includes('4.2 秒')),true);
 assert.equal(s.lab.log.some(e=>e.kind==='learn'&&e.text.includes('按住 a')),true);
 assert.equal(s.lab.log.every(e=>typeof e.at==='number'&&e.text.length<=300),true);
 const saved=JSON.parse(f.saved.get('petrival.jump.lab.v1.pet.p'));
 assert.equal(saved.log.length,s.lab.log.length);
 const rendered=f.node('#lab-log').textContent;
 assert.equal(rendered.includes('实验台'),true);assert.equal(rendered.includes('归纳'),true);
 const knows=f.node('#lab-knows').textContent;
 assert.equal(knows.includes('通道 a：按住 a 让精灵向右移动'),true);
 assert.equal(knows.includes('通道 b：还不知道'),true);
 assert.equal(knows.includes('确认 1 条'),true);
 f.api.labReveal();
 const revealed=f.node('#lab-knows').textContent;
 assert.equal(revealed.includes('通道 a'),true);
 assert.equal(f.api.get().lab.log.some(e=>e.kind==='reveal'),true);
});
test('split view draws two clipped panes, one camera per player',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 assert.equal(f.api.get().splitView,true,'the pet-on-top view is the default');
 f.api.draw();
 assert.equal(f.ops.filter(o=>o[0]==='clip').length,2,'one clipped pane per player');
 assert.deepEqual(f.ops.filter(o=>o[0]==='translate').map(o=>o[2]),[0,470]);
 assert.equal(f.canvas.height,940);
 assert.equal(f.ops.filter(o=>o[0]==='fillText'&&String(o[1]).includes('镜头')).length,2);
 f.node('#split').change({target:{checked:false}});
 f.api.draw();
 assert.equal(f.api.get().splitView,false);
 assert.equal(f.canvas.height,470);
 assert.equal(f.ops.filter(o=>o[0]==='clip').length,3,'single pane adds one clip');
 assert.equal(JSON.parse(f.saved.get('petrival.jump.split.v1')).splitView,false);
});
test('each pane shows only its own player and its own items',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 const coins=ops=>ops.filter(o=>o[0]==='fillRect'&&o[5]==='#f4cf62').length;
 f.api.draw();
 assert.equal(coins(f.ops),4,'both panes draw both of your uncollected coins to start with');
 assert.equal(f.ops.filter(o=>o[0]==='fillText'&&o[1]==='你').length,1,'only your pane draws you');
 assert.equal(f.ops.filter(o=>o[0]==='fillText'&&o[1]==='小精灵').length,1,'only its pane draws the pet');
 const labels=f.ops.filter(o=>o[0]==='fillText'&&String(o[1]).startsWith('镜头跟')).map(o=>String(o[1]));
 assert.equal(labels.some(t=>t.startsWith('镜头跟你 · 金币')),true);
 assert.equal(labels.some(t=>t.startsWith('镜头跟小精灵 · 金币')),true);
 const s=f.api.get();s.human.x=s.level.coins[0].x;s.human.y=s.level.coins[0].y+12;
 f.api.advance();
 f.ops.length=0;f.api.draw();
 assert.equal(f.api.get().humanProgress.coins.length,1,'you really did collect it');
 assert.equal(coins(f.ops),3,'the coin you ate is gone from your pane and still there in its pane');
 const yourPane=f.api.get().humanProgress.coins.length;
 assert.equal(yourPane,1);
});
test('a round restart keeps everything learned and clears only positions and goals',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});f.api.labBattery();
 const induction=f.api.labInduce();
 f.answer('/api/jump/lab/induce',{method:'model',model:'fixture',notebook:[{id:'n1',claim:'按住 a 让精灵向右移动',state:'确认',evidence:['x','y','z'],confidence:.9}],confirmed:1,learned:1,adjusted:[],nextExperiment:null,experiments:9,latencyMs:12});
 await induction;
 f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<15;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 const before=f.api.get();
 assert.equal(before.roundDemos,1);
 before.pet.x=520;
 f.api.restartRound();
 const after=f.api.get();
 assert.equal(after.lab.notebook.length,1,'the notebook survives a round restart');
 assert.equal(after.lab.traces.length,before.lab.traces.length,'the traces survive too');
 assert.equal(after.pet.x,after.level.spawn.x);
 assert.equal(after.human.x,after.level.spawn.x);
 assert.equal(after.progress.coins.length,0);
 assert.equal(after.progress.key,false);
 assert.equal(after.roundIndex,2);assert.equal(after.roundDemos,0);
 assert.equal(after.lab.log.some(e=>e.kind==='round'&&e.text.includes('保留')),true);
 assert.equal(f.node('#round-info').textContent.includes('第 2 轮'),true);
});
test('your demonstration is replayed under your own rules and carries your pickups',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 const start=f.api.get();
 start.pet.x=start.level.coins[0].x;start.pet.y=start.level.coins[0].y+12;
 f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<10;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 const trace=f.api.get().lab.traces.filter(t=>t.origin==='human').pop();
 assert.ok(trace,'the demonstration is stored as a trace');
 assert.equal(trace.progress.coins.length,1,'the replay collects with your own rules');
 assert.equal(f.api.get().lab.log.some(e=>e.kind==='demo'&&e.text.includes('金币')),true);
});
test('both players now collect on their own score',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 const start=f.api.get();
 start.human.x=start.level.coins[0].x;start.human.y=start.level.coins[0].y+12;
 for(let i=0;i<6;i++)f.api.advance();
 const s=f.api.get();
 assert.equal(s.humanProgress.coins.length,1,'the human collects coins like a real player');
 assert.equal(s.progress.coins.length,0,'the pet score stays untouched by the human');
 assert.equal(f.node('#objective').textContent.includes('你 金币 1/'),true);
 assert.equal(f.node('#objective').textContent.includes(`${'小精灵'} 金币 0/`),true);
});
test('both players respawn and restart their own attempt after falling',async()=>{
 const f=await fixture();f.api.nextWorld({first:true});
 const s0=f.api.get();s0.human.dead=true;
 f.api.advance();
 let s=f.api.get();
 assert.equal(s.human.dead,false,'the human respawns');
 assert.equal(s.human.x,s.level.spawn.x);
 assert.equal(s.humanFalls,1);
 assert.equal(s.lab.log.some(e=>e.kind==='fall'&&e.text.includes('你摔了')),true);
 s.progress.coins.push(0);
 f.api.fall();
 for(let i=0;i<50;i++)f.api.advance();
 s=f.api.get();
 assert.equal(s.pet.dead,false,'the pet respawns on its own');
 assert.equal(s.pet.x,s.level.spawn.x);
 assert.equal(s.progress.coins.length,0,'the pet restarts its own progress, not the shared one');
 assert.equal(s.lab.log.some(e=>e.kind==='fall'&&e.text.includes('小精灵')),true);
 assert.equal(f.node('#attempts').textContent.includes('你跌落 1 次'),true);
});
test('the log renders and persists in the classic lesson too, without a lab world',async()=>{
 const f=await fixture();
 assert.equal(f.api.get().mode,'classic');
 assert.equal(f.api.get().lab.world,null,'no lab world has been created yet');
 assert.equal(f.node('#lab-log').textContent.includes('还没有记录'),true,'the empty state explains what will be logged');
 f.api.restartRound();
 assert.equal(f.api.get().lab.log.length,1);
 const rendered=f.node('#lab-log').textContent;
 assert.equal(rendered.includes('重开'),true,'a round restart is visible in the log');
 assert.equal(rendered.includes('还没有记录'),false);
 assert.equal(JSON.parse(f.saved.get('petrival.jump.lab.v1.pet.p')).log.length,1,'game events persist as they happen');
 f.api.fall();
 for(let i=0;i<50;i++)f.api.advance();
 assert.equal(f.api.get().lab.log.some(e=>e.kind==='fall'),true,'a fall in the classic lesson is logged');
 assert.equal(f.node('#lab-log').textContent.includes('跌落'),true);
 assert.equal(f.node('#lab-knows').textContent.includes('模型权重不会变'),true,'the right column explains the mechanism');
 assert.equal(f.node('#lab-knows').textContent.includes('【示范记忆】'),true);
 assert.equal(f.node('#lab-knows').textContent.includes('【本次变化】'),true);
 assert.equal(f.node('#lab-knows').textContent.includes('【这一关】'),true);
 f.api.teach();f.key('keydown','ArrowRight');for(let i=0;i<10;i++)f.api.advance();f.key('keyup','ArrowRight');f.api.finishDemo();
 assert.equal(f.api.get().lab.log.some(e=>e.kind==='demo'&&e.text.includes('示范课')),true,'a classic demonstration is logged');
 assert.equal(f.node('#lab-log').textContent.includes('你的示范'),true);
 const memory=f.node('#lab-knows').textContent;
 assert.equal(memory.includes('新增 1 条'),true,'storing a demonstration is shown as a memory change');
 assert.equal(memory.includes('x=')&&memory.includes('10 帧'),true,'the stored demonstration is listed with its frames');
});
test('the ladder starts at walk-right and unlocks the next stage when either side clears it',async()=>{
 const f=await fixture();
 assert.equal(f.api.get().stageId,1);
 assert.equal(f.api.get().level.title,'第 1 关 · 先学会走');
 let bar=f.node('#stage-bar');
 assert.equal(bar.children.length,7,'seven stages are offered');
 assert.equal(bar.children[1].disabled,true,'stage 2 is locked until stage 1 is cleared');
 assert.equal(bar.children[0].textContent.includes('第 1 关 · 先学会走'),true);
 assert.equal(bar.children[0].attributes['aria-current'],'true');
 f.key('keydown','ArrowRight');
 for(let i=0;i<300;i++)f.api.advance();
 f.key('keyup','ArrowRight');
 const s=f.api.get();
 assert.equal(s.humanProgress.won,true,'walking right is enough to clear stage 1');
 assert.deepEqual(s.clearedStages,[1]);
 bar=f.node('#stage-bar');
 assert.equal(bar.children[1].disabled,false,'clearing stage 1 unlocks stage 2');
 assert.equal(bar.children[0].textContent.startsWith('✓ '),true,'the cleared stage is ticked');
 assert.equal(s.lab.log.some(e=>e.kind==='win'&&e.text.includes('第 1 关')),true);
 f.api.goToStage(6);
 assert.equal(f.api.get().stageId,1,'a locked stage is refused');
 assert.equal(f.api.get().status.includes('还没解锁'),true);
 f.api.goToStage(2);
 assert.equal(f.api.get().stageId,2);
 assert.equal(f.api.get().level.title,'第 2 关 · 学会跳');
 assert.equal(f.api.get().pet.x,f.api.get().level.spawn.x);
 assert.equal(JSON.parse(f.saved.get('petrival.jump.stage.v1.pet.p')).stageId,2,'the ladder position is remembered');
 assert.equal(f.node('#level-source').textContent.includes('课程第 2 关'),true);
});
test('the log records what the model chose, and the filter can narrow it to exactly that',async()=>{
 const f=await fixture();
 f.api.start();
 const payload=f.body('/api/jump/decision');
 assert.equal(payload.level.title,'第 1 关 · 先学会走');
 f.answer('/api/jump/decision',{method:'model',model:'fixture',latencyMs:12,goal:'走到坑边',usedDemonstrations:[],demonstrationsProvided:0,
   actions:[{move:1,jump:false,frames:20},{move:1,jump:true,frames:8}]});
 await flush();
 const choice=f.api.get().lab.log.find(e=>e.kind==='choice');
 assert.ok(choice,'a choice line is written for every model call');
 assert.equal(choice.text.includes('看到'),true,'it says what situation the model was shown');
 assert.equal(choice.text.includes('x=48'),true,'the situation includes where the pet stands');
 assert.equal(choice.text.includes('它选择：向右 20 帧，向右 + 跳 8 帧'),true,'it says exactly which keys it picked');
 assert.equal(choice.text.includes('目标「走到坑边」'),true);
 assert.equal(f.node('#lab-log').textContent.includes('它选择'),true);
 const filters=f.node('#log-filter');
 assert.equal(filters.children.length,4);
 assert.equal(filters.children[1].textContent,'只看它的选择');
 f.node('#log-filter').click({target:filters.children[1]});
 assert.equal(f.api.get().logFilter,'choice');
 assert.equal(f.node('#lab-log').textContent.includes('它选择'),true);
 assert.equal(f.node('#lab-log').textContent.includes('行动'),false,'the plumbing is filtered out');
});
