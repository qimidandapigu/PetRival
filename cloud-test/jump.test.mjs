import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './support.mjs';
import worker from '../cloud/worker.mjs';
import {starterLevel,actor,progress} from '../public/jump-world.mjs';
import http from 'node:http';
test('cloud jump authenticates, serializes model calls outside transaction, releases lease',async t=>{
 const DB=database();t.after(()=>DB.connection.close());let finish,seen;
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;seen=JSON.parse(body);finish=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({actions:[{move:1,jump:false,frames:10}],goal:'走',usedDemonstrations:[]})}}]}));};});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const env={DB,AI_MODE:'model',MODEL_API_KEY:'fixture',MODEL_NAME:'fixture',MODEL_CHAT_URL:`http://127.0.0.1:${upstream.address().port}`};
 const call=(path,data,cookie)=>worker.fetch(new Request('https://test.local'+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)}),env,{});
 const l=starterLevel(),input={level:l,actor:actor(l.spawn),progress:progress()};
 assert.equal((await call('/api/jump/decision',input)).status,401);
 const session=await call('/api/session',{}),cookie=session.headers.get('set-cookie').split(';')[0];
 const response=await call('/api/jump/decision',input,cookie),answer=response.json();
 for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,10));assert.ok(finish);
 assert.equal((await call('/api/jump/decision',input,cookie)).status,429);
 assert.equal((await call('/api/session',{},cookie)).status,200,'model does not hold database transaction');
 finish();const result=await answer;assert.equal(result.method,'model');assert.equal(result.actions[0].move,1);
 assert.ok(!seen.messages[1].content.includes('solution'));
 // A second request reaching the model proves the lease was released.
 finish=null;const second=await call('/api/jump/decision',input,cookie),secondBody=second.json();
 for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,10));assert.ok(finish);finish();assert.equal((await secondBody).method,'model');
});
