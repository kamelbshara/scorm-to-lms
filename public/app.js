const $ = id => document.getElementById(id);
let key = '', rows = [];
const message = (text, error=false) => { $('message').textContent=text; $('message').className=error?'error':'success'; };
async function api(path, options={}) {
  const response=await fetch('/api/admin/'+path,{...options,headers:{...options.headers,'x-admin-key':key}});
  if(!response.ok) {const body=await response.json().catch(()=>({}));throw new Error(body.error || 'Request failed');}
  return response;
}
async function loadExams() {
  const exams=await (await api('exams')).json();
  const selected=$('exams').value;
  $('exams').replaceChildren(new Option('Select an exam',''),...exams.map(e=>new Option(e.title,e.id)));
  if(exams.some(e=>e.id===selected)) $('exams').value=selected;
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();key=$('key').value;try {await loadExams();$('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;$('key').value='';message('Dashboard unlocked.');}catch(e){key='';message(e.message,true);}});
$('logout').onclick=()=>{key='';rows=[];$('dashboard').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('grades').replaceChildren();$('history').replaceChildren();message('Dashboard locked.');};
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function busy(form,task){const button=form.querySelector('button');button.disabled=true;return task().catch(e=>message(e.message,true)).finally(()=>{button.disabled=false;});}
$('package-form').onsubmit=e=>{e.preventDefault();busy(e.target,async()=>{message('Connecting your package…');const r=await api('packages',{method:'POST',body:new FormData(e.target)});download(await r.blob(),'connected-scorm.zip');await loadExams();message('Connected ZIP downloaded. Upload it to the LMS and test one attempt.');});};
$('roster-form').onsubmit=e=>{e.preventDefault();busy(e.target,async()=>{const csv=await $('roster').files[0].text();const result=await(await api('roster',{method:'POST',headers:{'Content-Type':'text/csv'},body:csv})).json();await grades();message(`${result.imported} students imported.`);});};
function table(body,data){body.replaceChildren(...data.map(values=>{const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value??'—';tr.append(td);}return tr;}));}
async function grades(){
  const examId=$('exams').value;if(!examId){rows=[];table($('grades'),[]);table($('history'),[]);$('summary').textContent='Choose an exam to see results.';return;}
  const data=await(await api('grades?examId='+encodeURIComponent(examId))).json();
  const map=new Map(data.students.map(s=>[s.id,{id:s.id,name:s.name,count:0}]));
  for(const a of data.attempts){let s=map.get(a.student_id);if(!s){s={id:a.student_id,name:a.student_name||'Unknown student',count:0};map.set(s.id,s);}s.count++;if(!s.attempt)s.attempt=a;}
  rows=[...map.values()].map(s=>[s.name,s.id,s.attempt?.score??'',s.attempt?.status??'Not attempted',s.count,s.attempt?new Date(s.attempt.received_at).toLocaleString():'']);
  table($('grades'),rows);table($('history'),data.attempts.map(a=>[a.student_id,a.score,a.status,new Date(a.received_at).toLocaleString()]));
  $('summary').textContent=`${rows.length} students · ${data.attempts.length} attempts · ${rows.filter(r=>r[4]===0).length} not attempted`;
}
$('exams').onchange=()=>grades().catch(e=>message(e.message,true));
$('refresh').onclick=async()=>{try{await loadExams();await grades();message('Results refreshed.');}catch(e){message(e.message,true);}};
$('export').onclick=()=>{if(!$('exams').value)return message('Select an exam first.',true);const escape=v=>'"'+String(/^[=+@\-\t\r]/.test(String(v))?"'"+v:v).replaceAll('"','""')+'"';download(new Blob([[['Name','Student ID','Score','Status','Attempts','Last received'],...rows].map(r=>r.map(escape).join(',')).join('\r\n')],{type:'text/csv'}),'grades.csv');};
