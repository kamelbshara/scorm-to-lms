import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'csv-parse/sync';
import { gradeRows, csvText } from '../public/gradebook.js';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/,'const {gradeRows,csvText}=window.testHelpers;\n');
const settle=()=>new Promise(r=>setImmediate(r));
function dashboard(gradeFetch) {
  const dom=new JSDOM(html,{url:'https://grades.example.org',runScripts:'outside-only'});
  const {window}=dom;window.testHelpers={gradeRows,csvText};
  window.fetch=async url=>({ok:true,json:()=>url.endsWith('/exams')?[{id:'e1',title:'Exam One'},{id:'e2',title:'Exam Two'}]:gradeFetch(url)});
  window.eval(script);
  return {dom,window,$:id=>window.document.getElementById(id)};
}
async function login(s){s.$('key').value='test-key-123';s.$('login-form').dispatchEvent(new s.window.Event('submit',{cancelable:true}));await settle();assert.equal(s.$('dashboard').hidden,false);}
const data=name=>({students:[{id:name,name}],attempts:[]});
test('roster supplies student name when the LMS sends a blank name, retaining non-attempters and zero scores',()=>{
  const rows=gradeRows({students:[{id:'s1',name:'Roster Name'},{id:'s2',name:'No Attempt'}],attempts:[{student_id:'s1',student_name:'',score:0,status:'failed',received_at:'2026-11-06T00:00:00Z'},{student_id:'s3',student_name:'From LMS',score:90,status:'passed',received_at:'2026-11-06T00:00:00Z'}]});
  assert.equal(rows[0][0],'Roster Name');assert.equal(rows[0][2],0);assert.equal(rows[1][3],'Not attempted');assert.equal(rows[2][0],'From LMS');
});
test('CSV preserves quoted names and protects formula-like cells with leading whitespace',()=>{
  const text=csvText([['Student, "One"','  =1+1',0,'passed',1,''],['@formula','normal',null,'',0,'']]);
  const parsed=parse(text);assert.equal(parsed[1][0],'Student, "One"');assert.equal(parsed[1][1],"'  =1+1");assert.equal(parsed[2][0],"'@formula");assert.equal(parsed[1][2],'0');
});
test('a slow response for a previous exam cannot replace the selected exam results',async()=>{
  let release;const old=new Promise(r=>release=r);
  const s=dashboard(url=>url.endsWith('e1')?old:data('Current Student'));
  try {
    await login(s);s.$('exams').value='e1';s.$('exams').dispatchEvent(new s.window.Event('change'));await settle();
    assert.equal(s.$('export').disabled,true);
    s.$('exams').value='e2';s.$('exams').dispatchEvent(new s.window.Event('change'));await settle();
    release(data('Wrong Student'));await settle();
    assert.match(s.$('grades').textContent,/Current Student/);assert.doesNotMatch(s.$('grades').textContent,/Wrong Student/);
  } finally {s.dom.window.close();}
});
test('locking the dashboard clears records and ignores any in-flight result response',async()=>{
  let release;const pending=new Promise(r=>release=r);const s=dashboard(()=>pending);
  try {
    await login(s);s.$('exams').value='e1';s.$('exams').dispatchEvent(new s.window.Event('change'));await settle();
    s.$('logout').click();release(data('Private Student'));await settle();
    assert.equal(s.$('dashboard').hidden,true);assert.equal(s.$('grades').children.length,0);assert.equal(s.$('exams').value,'');assert.equal(s.$('export').disabled,true);
  } finally {s.dom.window.close();}
});
test('student names are rendered as text rather than HTML',async()=>{
  const s=dashboard(()=>data('<img src=x onerror=alert(1)>'));
  try {await login(s);s.$('exams').value='e1';s.$('exams').dispatchEvent(new s.window.Event('change'));await settle();assert.equal(s.$('grades').querySelector('img'),null);assert.match(s.$('grades').textContent,/<img/);}finally{s.dom.window.close();}
});
