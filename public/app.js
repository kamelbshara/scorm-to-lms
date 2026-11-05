import { gradeRows, csvText } from './gradebook.js';
const $ = id => document.getElementById(id);
let key = '', rows = [], session = 0, gradeRequest = 0, examRequest = 0;
const message = (text, error=false) => { $('message').textContent=text; $('message').className=error?'error':'success'; };
const stale = () => Object.assign(new Error('Request superseded'), {name:'StaleRequest'});
function report(error) { if (error.name !== 'StaleRequest') message(error.message, true); }
async function api(path, options={}) {
  const active = session;
  const response = await fetch('/api/admin/' + path, {...options, headers:{...options.headers,'x-admin-key':key}, cache:'no-store'});
  if (active !== session) throw stale();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (active !== session) throw stale();
    throw new Error(body.error || (response.status === 413 ? 'File is too large for this host. Vercel supports connected ZIPs up to 4 MB.' : 'Request failed. Please retry.'));
  }
  return response;
}
async function loadExams() {
  const active=session, request=++examRequest;
  const exams=await (await api('exams')).json();
  if (active !== session || request !== examRequest) throw stale();
  const selected=$('exams').value;
  $('exams').replaceChildren(new Option('Select an exam',''),...exams.map(e=>new Option(e.title,e.id)));
  if (exams.some(e=>e.id===selected)) $('exams').value=selected;
}
async function busy(form, task) {
  const button=form.querySelector('button'); button.disabled=true;
  try { await task(); } catch(error) { report(error); } finally { button.disabled=false; }
}
$('login-form').addEventListener('submit', e => {
  e.preventDefault();
  void busy(e.target, async () => {
    session++; key=$('key').value;
    try { await loadExams(); } catch(error) { if(error.name!=='StaleRequest') key=''; throw error; }
    $('login').hidden=true; $('dashboard').hidden=false; $('logout').hidden=false; $('key').value='';
    message('Dashboard unlocked.');
  });
});
function table(body, data) {
  body.replaceChildren(...data.map(values => {
    const tr=document.createElement('tr');
    for (const value of values) { const td=document.createElement('td'); td.textContent=value??'—'; tr.append(td); }
    return tr;
  }));
}
function clearGrades() {
  rows=[]; table($('grades'),[]); table($('history'),[]); $('export').disabled=true;
}
$('logout').onclick = () => {
  session++; gradeRequest++; examRequest++; key='';
  $('dashboard').hidden=true; $('login').hidden=false; $('logout').hidden=true;
  $('key').value=''; $('package-form').reset(); $('roster-form').reset(); $('exams').replaceChildren(new Option('Select an exam',''));
  clearGrades(); $('summary').textContent='Choose an exam to see results.'; message('Dashboard locked.');
};
function download(blob, name) {
  const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=name;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('package-form').onsubmit = e => {
  e.preventDefault(); const active=session;
  void busy(e.target, async () => {
    message('Connecting your package…');
    const response=await api('packages',{method:'POST',body:new FormData(e.target)});
    const blob=await response.blob(); if(active!==session) throw stale();
    const name=response.headers.get('Content-Disposition')?.match(/filename="([a-z0-9-]+\.zip)"/i)?.[1] || 'connected-scorm.zip';
    download(blob,name); await loadExams();
    message('Connected ZIP downloaded. Upload it to the LMS and test one attempt.');
  });
};
$('roster-form').onsubmit = e => {
  e.preventDefault(); const active=session;
  void busy(e.target, async () => {
    const csv=await $('roster').files[0].text(); if(active!==session) throw stale();
    const result=await(await api('roster',{method:'POST',headers:{'Content-Type':'text/csv'},body:csv})).json();
    if(active!==session) throw stale(); await grades();
    message(`${result.imported} students imported.`);
  });
};
async function grades() {
  const examId=$('exams').value, active=session, request=++gradeRequest;
  clearGrades();
  if(!examId) { $('summary').textContent='Choose an exam to see results.'; return; }
  $('summary').textContent='Loading results…';
  const data=await(await api('grades?examId='+encodeURIComponent(examId))).json();
  if(active!==session || request!==gradeRequest || examId!==$('exams').value) throw stale();
  rows=gradeRows(data); table($('grades'),rows);
  table($('history'),data.attempts.map(a=>[a.student_id,a.score,a.status,new Date(a.received_at).toLocaleString()]));
  $('summary').textContent=`${rows.length} students · ${data.attempts.length} attempts · ${rows.filter(r=>r[4]===0).length} not attempted`;
  $('export').disabled=false;
}
$('exams').onchange=()=>grades().catch(report);
$('refresh').onclick=async()=>{try{await loadExams();await grades();message('Results refreshed.');}catch(error){report(error);}};
$('export').onclick=()=>{if(!$('exams').value)return message('Select an exam first.',true);download(new Blob(['\ufeff',csvText(rows)],{type:'text/csv;charset=utf-8'}),'grades.csv');};
