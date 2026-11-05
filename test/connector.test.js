import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../connector.js',import.meta.url),'utf8');
function setup({offline=false,storageFails=false,local=new Map(),session=new Map()}={}) {
  const values={'cmi.core.student_id':'student-42','cmi.core.student_name':'Test Student','cmi.core.score.raw':'','cmi.core.lesson_status':'incomplete'};
  const calls=[],timers=[],listeners={};let online=!offline;
  const api={LMSInitialize:()=> 'true',LMSGetValue:k=>values[k]??'',LMSSetValue:(k,v)=>{values[k]=v;return 'true';},LMSCommit:()=> 'true',LMSFinish:()=> 'true'};
  const parent={API:api};parent.parent=parent;
  const window={parent,addEventListener:(name,fn)=>listeners[name]=fn};
  const storage=map=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>{if(storageFails)throw Error('blocked');map.set(k,v);},removeItem:k=>map.delete(k)});
  const context={window,localStorage:storage(local),sessionStorage:storage(session),crypto:{randomUUID},console:{warn:()=>{}},setInterval:fn=>timers.push(fn),fetch:async(_url,options)=>{if(!online)throw Error('offline');calls.push(JSON.parse(options.body));return {ok:true};}};
  vm.runInNewContext(`(${source})(${JSON.stringify({examId:'exam-1',token:'token',endpoint:'https://example.org/api/results'})})`,context);
  return {api:window.API,calls,local,session,listeners,online:()=>{online=true;},flush:()=>timers[0](),values};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('forwards scores and identity, clears acknowledged snapshots',async()=>{
  const s=setup();await settle();assert.equal(s.api.LMSInitialize(''),'true');await settle();
  s.api.LMSSetValue('cmi.core.score.raw','87');s.api.LMSSetValue('cmi.core.lesson_status','passed');await settle();s.flush();await settle();
  assert.equal(s.calls.at(-1).score,87);assert.equal(s.calls.at(-1).status,'passed');assert.equal(s.calls.at(-1).studentId,'student-42');
  assert.equal(JSON.parse([...s.local.values()][0]).length,0);
});
test('retains offline results, replays after a reload, and does not create an extra attempt after Finish',async()=>{
  const s=setup({offline:true});await settle();s.api.LMSInitialize('');s.api.LMSSetValue('cmi.core.score.raw','92');s.api.LMSFinish('');s.listeners.pagehide();await settle();
  const queued=JSON.parse([...s.local.values()][0]);assert.equal(queued.length,1);assert.equal(queued[0].score,92);
  const next=setup({local:s.local,session:s.session});await settle();assert.equal(next.calls.length,1);assert.equal(next.calls[0].attemptId,queued[0].attemptId);
  assert.equal(JSON.parse([...s.local.values()][0]).length,0);
});
test('keeps a memory queue when localStorage writes are blocked',async()=>{
  const s=setup({offline:true,storageFails:true});await settle();s.api.LMSInitialize('');s.api.LMSSetValue('cmi.core.score.raw','76');await settle();s.online();s.flush();await settle();assert.equal(s.calls.at(-1).score,76);
});
test('does not submit an attempt without an LMS student ID',async()=>{
  const s=setup();await settle();s.values['cmi.core.student_id']='';s.api.LMSInitialize('');await settle();assert.equal(s.calls.length,0);
});
