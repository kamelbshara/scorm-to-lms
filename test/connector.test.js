import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../connector.js',import.meta.url),'utf8');
function setup({offline=false,storageFails=false,local=new Map(),session=new Map(),apiOverrides={},fetchResponse}={}) {
  const values={'cmi.core.student_id':'student-42','cmi.core.student_name':'Test Student','cmi.core.score.raw':'','cmi.core.lesson_status':'incomplete'};
  const calls=[],timers=[],listeners={};let online=!offline;
  const api={LMSInitialize:()=> 'true',LMSGetValue:k=>values[k]??'',LMSSetValue:(k,v)=>{values[k]=v;return 'true';},LMSCommit:()=> 'true',LMSFinish:()=> 'true',...apiOverrides};
  const parent={API:api};parent.parent=parent;
  const window={parent,addEventListener:(name,fn)=>listeners[name]=fn};
  const storage=map=>({get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,setItem:(k,v)=>{if(typeof storageFails==='function'?storageFails():storageFails)throw Error('blocked');map.set(k,v);},removeItem:k=>map.delete(k)});
  const context={AbortController,setTimeout,clearTimeout,window,localStorage:storage(local),sessionStorage:storage(session),crypto:{randomUUID},console:{warn:()=>{}},setInterval:fn=>timers.push(fn),fetch:async(_url,options)=>{if(!online)throw Error('offline');calls.push(JSON.parse(options.body));return fetchResponse ? fetchResponse(JSON.parse(options.body)) : {ok:true,json:async()=>({saved:true})};}};
  vm.runInNewContext(`(${source})(${JSON.stringify({examId:'exam-1',token:'token',endpoint:'https://example.org/api/results'})})`,context);
  return {api:window.API,calls,local,session,listeners,online:()=>{online=true;},flush:()=>timers[0](),values,context,parent};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('forwards scores and identity, clears acknowledged snapshots',async()=>{
  const s=setup();await settle();assert.equal(s.api.LMSInitialize(''),'true');await settle();
  s.api.LMSSetValue('cmi.core.score.raw','87');s.api.LMSSetValue('cmi.core.lesson_status','passed');await settle();s.flush();await settle();
  assert.equal(s.calls.at(-1).score,87);assert.equal(s.calls.at(-1).status,'passed');assert.equal(s.calls.at(-1).studentId,'student-42');
  assert.equal(s.local.size,0);
});
test('retains offline results, replays after a reload, and does not create an extra attempt after Finish',async()=>{
  const s=setup({offline:true});await settle();s.api.LMSInitialize('');s.api.LMSSetValue('cmi.core.score.raw','92');s.api.LMSFinish('');s.listeners.pagehide();await settle();
  const queued=[...s.local.values()].map(v=>JSON.parse(v));assert.equal(queued.length,1);assert.equal(queued[0].score,92);
  const next=setup({local:s.local,session:s.session});await settle();assert.equal(next.calls.length,1);assert.equal(next.calls[0].attemptId,queued[0].attemptId);
  assert.equal(s.local.size,0);
});
test('keeps a memory queue when localStorage writes are blocked',async()=>{
  const s=setup({offline:true,storageFails:true});await settle();s.api.LMSInitialize('');s.api.LMSSetValue('cmi.core.score.raw','76');await settle();s.online();s.flush();await settle();assert.equal(s.calls.at(-1).score,76);
});
test('does not submit an attempt without an LMS student ID',async()=>{
  const s=setup();await settle();s.values['cmi.core.student_id']='';s.api.LMSInitialize('');await settle();assert.equal(s.calls.length,0);
});

test('never deletes results on HTTP 200 without a database acknowledgement',async()=>{
  const s=setup({fetchResponse:()=>({ok:true,json:async()=>{throw Error('login HTML, not JSON');}})});await settle();s.api.LMSInitialize('');await settle();assert.equal(s.local.size,1);
});
test('an old in-flight acknowledgement cannot remove a newer queued snapshot',async()=>{
  let release;let first=true;
  const s=setup({fetchResponse:()=>first?(first=false,new Promise(r=>release=r)):{ok:true,json:async()=>({saved:true})}});
  s.api.LMSInitialize('');await settle();s.api.LMSSetValue('cmi.core.score.raw','98');
  release({ok:true,json:async()=>({saved:true})});await settle();
  assert.equal(s.local.size,1);assert.equal(JSON.parse([...s.local.values()][0]).score,98);
  s.flush();await settle();assert.equal(s.local.size,0);
});
test('a permanently rejected attempt does not stop another student syncing',async()=>{
  const local=new Map();const config={examId:'exam-1',token:'token',status:'passed',score:90,studentName:'Test'};
  for(const id of ['bad','good'])local.set('scorm-gradebook:exam-1:pending:'+id+':1',JSON.stringify({...config,attemptId:id,revision:1,studentId:id}));
  const s=setup({local,fetchResponse:e=>({ok:e.attemptId!=='bad',json:async()=>({saved:true})})});await settle();
  assert.equal(s.calls.length,2);assert.equal(s.local.size,1);assert.equal(JSON.parse([...s.local.values()][0]).studentId,'bad');
});
test('shared storage retains independent students while offline',async()=>{
  const local=new Map();const a=setup({offline:true,local}),b=setup({offline:true,local});b.values['cmi.core.student_id']='student-99';
  a.api.LMSInitialize('');b.api.LMSInitialize('');await settle();assert.equal(local.size,2);
  a.online();a.flush();await settle();assert.equal(local.size,0);assert.equal(a.calls.length,2);
});
test('failed LMSFinish keeps the current attempt open',async()=>{
  let finish=false;
  const s=setup({offline:true,apiOverrides:{LMSFinish:()=>String(finish)}});s.api.LMSInitialize('');await settle();
  const original=JSON.parse([...s.local.values()][0]).attemptId;
  assert.equal(s.api.LMSFinish(''),'false');s.api.LMSSetValue('cmi.core.score.raw','85');finish=true;s.api.LMSFinish('');await settle();
  const event=JSON.parse([...s.local.values()][0]);assert.equal(event.attemptId,original);assert.equal(event.score,85);assert.equal(s.local.size,1);
});
test('does not capture on pagehide before a successful initialization',async()=>{
  const s=setup({apiOverrides:{LMSInitialize:()=> 'false'}});s.api.LMSInitialize('');s.listeners.pagehide();await settle();assert.equal(s.calls.length,0);
});
test('tracker reads do not change the LMS error returned to the SCO',async()=>{
  let error='0';
  const s=setup({apiOverrides:{LMSGetValue:k=>{error='401';return k==='cmi.core.student_id'?'student-42':k==='cmi.core.lesson_status'?'incomplete':'';},LMSGetLastError:()=>error,LMSInitialize:()=>{error='0';return 'true';}}});
  s.api.LMSInitialize('');assert.equal(s.api.LMSGetLastError(),'0');await settle();
});
test('legacy pending results survive upgrade and are removed only after acknowledgement',async()=>{
  const local=new Map([['scorm-gradebook:exam-1:queue',JSON.stringify([{examId:'exam-1',attemptId:'legacy',revision:1,score:80,studentId:'s1'}])]]);
  const s=setup({offline:true,local});await settle();assert.equal(local.has('scorm-gradebook:exam-1:queue'),false);assert.equal(local.size,1);
  s.online();s.flush();await settle();assert.equal(local.size,0);assert.equal(s.calls[0].score,80);
});

test('storage quota failure retains both existing durable results and the new memory result',async()=>{
  let blocked=false;
  const s=setup({offline:true,storageFails:()=>blocked});s.api.LMSInitialize('');await settle();
  blocked=true;s.values['cmi.core.student_id']='second-student';s.api.LMSSetValue('cmi.core.score.raw','88');await settle();
  s.online();await s.flush();assert.equal(s.calls.length,2);assert.deepEqual(new Set(s.calls.map(e=>e.studentId)),new Set(['student-42','second-student']));assert.equal(s.local.size,0);
});
