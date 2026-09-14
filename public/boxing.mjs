import { petMarkup, defaultAppearance } from '/shared/pet.mjs';
const root = document.querySelector('#boxing-dialog');
const $ = s => root.querySelector(s), escape = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lobby, onClose, match, generation=0, pollBusy=false, seq=0, desired='idle', sent='', lastSend=0, sending=false, loadedAt=performance.now();
const held=new Map(), paints=new Map(), attackQueue=[];
let cloudWorkers = false;
async function cloudWork() {
  while (true) {
    try { if (match?.status === 'active' && lobby?.mode === 'model') await api('/api/boxing/work', {}); } catch { /* regular polling reports connection state */ }
    await new Promise(resolve => setTimeout(resolve, match?.status === 'active' ? 200 : 1000));
  }
}
function notice(message=''){ $('#boxing-notice').textContent=message;$('#boxing-notice').hidden=!message; }
async function api(path,input){
  const response=await fetch(path,{method:input===undefined?'GET':'POST',headers:input===undefined?{}:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(8000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'连接中断');return data;
}
function show(next){generation++;match=next;seq=next.human.seq||0;held.clear();attackQueue.length=0;desired='idle';sent='';paints.clear();loadedAt=performance.now();notice();$('#fight').hidden=false;if(!root.open)root.showModal();history.replaceState(null,'',`/#boxing:${next.id}`);render();}
function time(bout){if(!bout.fighters)return '--';return String(Math.ceil(Math.max(0,45000-bout.frame*50)/1000)).padStart(2,'0');}
function hp(f,name,enemy=false){return `<div class="${enemy?'enemy':''}"><div class="hp-name"><b>${escape(name)}</b><span>${f.hp} / ${f.maxHp}</span></div><progress class="hp-track" max="${f.maxHp}" value="${f.hp}" aria-label="${escape(name)}血量"></progress></div>`;}
const winnerText=(bout,names)=>bout.winner===null?'平局':`${names[bout.winner]} 获胜`;
function render(){
  if(!match)return; const names=match.pets.map(p=>p.name), own=match.side, foe=1-own;
  $('#match-title').textContent=`${names[own]}  vs  ${names[foe]}`;$('#match-kind').textContent=match.training?'TRAINING · 训练拳台，不计排名':'RANKED · 宠物积分挑战';
  $('#pet-hud').innerHTML=hp(match.petBout.fighters[0],names[0])+`<div class="clock">${time(match.petBout)}<small>SECONDS</small></div>`+hp(match.petBout.fighters[1],names[1],true);
  $('#human-hud').innerHTML=match.human.fighters?hp(match.human.fighters[0],'你 · '+names[own])+`<div class="clock">${time(match.human)}<small>SECONDS</small></div>`+hp(match.human.fighters[1],names[foe]+' ×5',true):'<p>你的真人场尚未开始</p>';
  const aiNote=bout=>{
    const decisions=bout.decisions.filter(Boolean);
    const skills=decisions.filter(d=>d.skillStatus).map(d=>`技能「${d.skillStatus.name}」：${d.skillStatus.message}`).join('；');
    const note=decisions.some(d=>d.status==='unavailable')?'模型响应异常，暂时站立等待；正在重试':decisions.length&&decisions.every(d=>d.source==='skill')?'技能正在控制宠物':lobby.mode!=='model'?'算法陪练正在自动操作':!decisions.length?'等待模型第一组动作，暂时站立等待':`DeepSeek 无思考 · 已收到 ${decisions.reduce((n,d)=>n+(d.calls||0),0)} 组动作`;
    return note+(skills?' · '+skills:'');
  };
  const feedback=(bout,labels)=>(bout.fighters||[]).map((f,i)=>f.cue?.until>bout.frame?`${labels[i]}：${f.cue.message}`:'').filter(Boolean).join(' · ');
  $('#boxing-rules').textContent=match.human.rulesVersion===2?'按住连续行动，松手站立；只有按住 L 或防御按钮才防御。J 轻拳打断慢招，L 防住重拳后用 J 反击，I 抱摔克制防御；后退可骗招打空。普通拳被防住不掉血，重拳收招时挨打会多受伤害。时间到比较剩余血量百分比。':'这是更新前开始的对局，沿用旧规则：J 轻拳、K 重拳、L 防御，防御仍受少量伤害，本局不支持抱摔。松手站立；时间到比较剩余血量百分比。';
  $('#pet-feedback').textContent=feedback(match.petBout,names);
  $('#human-feedback').textContent=feedback(match.human,['你',names[foe]]);
  $('#pet-status').textContent=match.petBout.status==='done'?winnerText(match.petBout,names):aiNote(match.petBout);
  $('#human-status').textContent=match.human.status==='pending'?'点击下方按钮开始，你和对手的真人场独立计时。':match.human.status==='done'?winnerText(match.human,['你',names[foe]+' ×5']):'你控制左侧拳手 · '+aiNote(match.human);
  $('#rematch').hidden=!['done','void'].includes(match.status);
  $('#join').hidden=match.human.status!=='pending'||match.status!=='active';$('#surrender').disabled=match.human.status!=='running'||match.status!=='active';
  root.querySelectorAll('[data-action]').forEach(b=>{b.hidden=b.dataset.action==='throw'&&match.human.rulesVersion!==2;b.disabled=match.human.status!=='running'||match.status!=='active';b.classList.toggle('active',!b.disabled&&b.dataset.action===desired);});
  if(match.status==='void')$('#result').textContent=match.reason;
  else if(match.results){const r=match.results.sides[own];$('#result').textContent=`${match.training?'训练结束，不计排名。':'本场已计入拳台排名。'} 宠物 ${r.pet.score>=0?'+':''}${r.pet.score} / 真人 ${r.human?.score>=0?'+':''}${r.human?.score??'未参赛'} / 合计 ${r.score} 分。${match.training?'':match.results.winner===null?'双方平局。':match.results.winner===own?'你的队伍获胜！':'对方队伍获胜。'}`;}
  else $('#result').textContent=match.petBout.status==='done'&&match.human.status==='done'?'你的双场已结束，等待对方主人完成真人场；未开始不会判负。':'';
}
async function poll(){if(!match||pollBusy)return;pollBusy=true;const id=match.id,version=generation;try{const next=await api(`/api/boxing/${id}`);if(generation!==version||match?.id!==id)return;match=next;seq=Math.max(seq,next.human.seq||0);loadedAt=performance.now();render();notice();}catch(e){if(generation===version)notice('进度连接中断，正在重连。战斗计时继续。');}finally{pollBusy=false;}}
function updateInput(){desired=[...held.values()].at(-1)||'idle';root.querySelectorAll('[data-action]').forEach(b=>b.classList.toggle('active',b.dataset.action===desired));send();}
async function send(){if(!match||match.status!=='active'||match.human.status!=='running'||sending||!attackQueue.length&&desired===sent&&Date.now()-lastSend<750)return;const id=match.id,action=attackQueue.shift()||desired;sending=true;lastSend=Date.now();seq++;try{await api(`/api/boxing/${id}/input`,{action,seq});if(match?.id===id)sent=action;}catch(e){if(match?.id===id)notice(e.message);}finally{sending=false;if(attackQueue.length)send();}}
const keys={a:'retreat',ArrowLeft:'retreat',d:'advance',ArrowRight:'advance',j:'jab',k:'heavy',l:'guard',i:'throw'};
window.addEventListener('keydown',e=>{const key=e.key.length===1?e.key.toLowerCase():e.key;if(!root.open||!match||!keys[key]||e.target.matches('input,textarea'))return;e.preventDefault();if(!e.repeat){held.set(key,keys[key]);if(['jab','heavy','throw'].includes(keys[key])&&attackQueue.length<2)attackQueue.push(keys[key]);updateInput();}});
window.addEventListener('keyup',e=>{const key=e.key.length===1?e.key.toLowerCase():e.key;if(keys[key]){held.delete(key);updateInput();}});
window.addEventListener('blur',()=>{held.clear();updateInput();});document.addEventListener('visibilitychange',()=>{if(document.hidden){held.clear();updateInput();}else poll();});
for(const b of root.querySelectorAll('[data-action]')){b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);held.set('pointer',b.dataset.action);if(['jab','heavy','throw'].includes(b.dataset.action)&&attackQueue.length<2)attackQueue.push(b.dataset.action);updateInput();});for(const name of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(name,()=>{held.delete('pointer');updateInput();});}
function closeBoxing(){held.clear();attackQueue.length=0;desired='idle';send();generation++;match=null;root.close();history.replaceState(null,'','/#boxing');onClose?.();}
$('#back').onclick=closeBoxing;
root.addEventListener('cancel',event=>{event.preventDefault();closeBoxing();});
export async function openBoxing(next, context, afterClose){lobby=context;onClose=afterClose;show(next);if(lobby.storage==='D1'&&!cloudWorkers){cloudWorkers=true;cloudWork();cloudWork();}}
$('#rematch').onclick=async()=>{const b=$('#rematch');b.disabled=true;try{show(await api('/api/boxing',{opponentId:match.petIds[1-match.side]}));}catch(e){notice(e.message);}finally{b.disabled=false;}};
$('#join').onclick=async()=>{try{show(await api(`/api/boxing/${match.id}/start`,{}));}catch(e){notice(e.message);}};
$('#surrender').onclick=async()=>{try{const id=match.id;const next=await api(`/api/boxing/${id}/surrender`,{});if(match?.id===id){match=next;render();}}catch(e){notice(e.message);}};
function rect(ctx,color,x,y,w,h){ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),w,h);}
function text(ctx,value,x,y,size=16,color='#e9e4d7'){ctx.fillStyle=color;ctx.font=`bold ${size}px monospace`;ctx.textAlign='center';ctx.fillText(value,x,y);}
function drawFighter(ctx,f,pet,i,now,key){
  const previous=paints.get(key)??f.x, x=previous+(f.x-previous)*.3;paints.set(key,x);
  const walking=['advance','retreat'].includes(f.action), bounce=walking?Math.sin(now/60)*4:Math.sin(now/220+i)*2;
  const forward=f.facing, punch=['jab','heavy','throw'].includes(f.action), stretch=punch?(f.attack?.age<3?12:37):0;
  ctx.save();ctx.translate(x,290+bounce);if(f.hp<=0){ctx.translate(0,20);ctx.rotate(i?-.9:.9);}
  ctx.fillStyle='#111a26aa';ctx.beginPath();ctx.ellipse(0,37,58,10,0,0,Math.PI*2);ctx.fill();
  const pixels=pet.appearance?.pixels??defaultAppearance(pet.species).pixels;
  for(let p=0;p<256;p++)if(pixels[p])rect(ctx,f.flash>0&&Math.floor(now/45)%2?'#fff6df':pixels[p],(p%16-8)*5,Math.floor(p/16)*5-63,5,5);
  rect(ctx,'#151d2a',-34,27,25,13);rect(ctx,'#151d2a',13,27,25,13);
  const color=i?'#ec8e55':'#59bdb0', gloveX=forward*(f.action==='guard'?32:45+stretch), gloveY=f.action==='guard'?-32:-10;
  rect(ctx,'#263242',gloveX-17,gloveY-17,34,34);rect(ctx,color,gloveX-13,gloveY-13,26,26);rect(ctx,'#fff5d0',gloveX-10,gloveY-11,9,5);
  rect(ctx,'#263242',-forward*32-11,0,23,23);rect(ctx,color,-forward*32-8,3,17,17);
  if(f.cue?.until > (key.startsWith('0:') ? match.petBout.frame : match.human.frame)){text(ctx,f.cue.message,0,-105,14,'#ffe39a');}
  if(f.attack && f.attack.age >= ({jab:3,heavy:8,throw:7}[f.attack.kind]||99)){text(ctx,'收招中',0,-82,13,'#ffb078');}
  if(f.flash>0){text(ctx,f.action==='guard'?'BLOCK':'HIT!',0,-90,16,f.action==='guard'?'#89edec':'#ffc38b');}
  ctx.restore();text(ctx,pet.name,x,377,16,i?'#ffc194':'#9ce8da');
}
function drawRing(canvas,bout,pets,variant,now){
  const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;const w=800;
  const sky=ctx.createLinearGradient(0,0,0,420);sky.addColorStop(0,variant?'#352c38':'#233344');sky.addColorStop(1,'#121d2d');ctx.fillStyle=sky;ctx.fillRect(0,0,w,420);
  for(let i=0;i<19;i++){const x=i*47;rect(ctx,i%3?'#1a2634':'#273442',x,65+i%5*17,37,153);for(let y=95;y<200;y+=29)rect(ctx,i%4?'#729c9755':'#d69c7855',x+8,y,5,8);}
  rect(ctx,'#d6c6a82b',392,15,16,110);rect(ctx,'#d6c6a8',381,14,38,8);text(ctx,variant?'THE CHALLENGER':'PET FIGHT CLUB',400,80,22,variant?'#f9b983':'#91dacc');text(ctx,variant?'HP ×5  /  ATK ×5':'READ. BAIT. COUNTER.',400,105,11,'#8999ab');
  for(let y=180;y<=300;y+=43){rect(ctx,'#0d1723',30,y+5,740,6);rect(ctx,variant?'#ab7459':'#547f85',30,y,740,4);}
  rect(ctx,'#182335',0,325,800,95);rect(ctx,variant?'#a57151':'#4c8f89',0,325,800,9);
  ctx.strokeStyle='#ffffff09';for(let x=-200;x<1000;x+=100){ctx.beginPath();ctx.moveTo(400+(x-400)*.65,334);ctx.lineTo(x,420);ctx.stroke();}for(let y=350;y<420;y+=22)rect(ctx,'#ffffff09',0,y,800,1);
  for(const x of [25,755]){rect(ctx,'#839398',x,150,20,182);rect(ctx,'#455467',x+4,161,12,165);}
  if(!bout.fighters){text(ctx,'READY WHEN YOU ARE',400,250,27);return;}
  bout.fighters.forEach((f,i)=>drawFighter(ctx,f,pets[i],i,now,`${variant}:${i}`));
  if(bout.status==='done'){ctx.fillStyle='#0c1727b8';ctx.fillRect(130,125,540,95);text(ctx,bout.winner===null?'DRAW':bout.reason==='ko'?'K.O.':'TIME / RESULT',400,165,37,'#ffcf8d');text(ctx,winnerText(bout,pets.map(p=>p.name)),400,196,18);}
  else if(match&&match.now<bout.startedAt){text(ctx,'READY '+Math.ceil((bout.startedAt-match.now)/1000),400,220,38,'#ffe0a6');}
}
function animate(now){if(match){drawRing($('#pet-ring'),match.petBout,match.pets,0,now);drawRing($('#human-ring'),match.human,[match.pets[match.side],match.pets[1-match.side]],1,now);}requestAnimationFrame(animate);}
setInterval(poll,250);setInterval(send,180);requestAnimationFrame(animate);
