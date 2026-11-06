import { gradeRows, csvText, questionRows, studentAnswerRows, analysisCsvText } from './gradebook.js';
const $ = id => document.getElementById(id);
let key = '', rows = [], session = 0, gradeRequest = 0, examRequest = 0;
let analysisData = null; // {questions, studentAnswers} from /api/admin/analysis
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
  clearAnalysis();
}
function clearAnalysis() {
  analysisData = null;
  $('load-analysis').disabled = true;
  $('export-analysis').disabled = true;
  $('analysis-status').textContent = '';
  $('analysis-summary').textContent = '';
  table($('q-body'), []);
  $('q-section').hidden = true;
  $('student-answers-section').hidden = true;
  $('answer-student').replaceChildren(new Option('Select a student',''));
  table($('answer-body'), []);
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
  // Enable analysis if exam has attempts
  if (data.attempts.length > 0) $('load-analysis').disabled = false;
}
$('exams').onchange=()=>grades().catch(report);
$('refresh').onclick=async()=>{try{await loadExams();await grades();message('Results refreshed.');}catch(error){report(error);}};
$('export').onclick=()=>{if(!$('exams').value)return message('Select an exam first.',true);download(new Blob(['﻿',csvText(rows)],{type:'text/csv;charset=utf-8'}),'grades.csv');};

// --- Answer Analysis ---

$('load-analysis').onclick = async () => {
  const examId = $('exams').value;
  if (!examId) return message('Select an exam first.', true);
  $('load-analysis').disabled = true;
  $('analysis-status').textContent = 'Loading analysis…';
  try {
    const data = await (await api('analysis?examId=' + encodeURIComponent(examId))).json();
    analysisData = data;
    renderAnalysis(data);
    $('analysis-status').textContent = '';
    $('export-analysis').disabled = false;
    // Scroll analysis section into view
    $('analysis-section').open = true;
    $('analysis-section').scrollIntoView({behavior:'smooth', block:'start'});
    message('Answer analysis loaded.');
  } catch(err) {
    $('analysis-status').textContent = '';
    $('load-analysis').disabled = false;
    report(err);
  }
};

function renderAnalysis(data) {
  const {questions, studentAnswers} = data;
  const studentCount = Object.keys(studentAnswers).length;
  const qCount = questions.length;
  if (!qCount) {
    $('analysis-summary').textContent = studentCount
      ? `${studentCount} student(s) attempted this exam but the SCORM package did not report individual question responses. Only score and status are available.`
      : 'No interaction data recorded yet. Students must attempt the exam with a connected package that reports question responses.';
    $('q-section').hidden = true;
    $('student-answers-section').hidden = true;
    return;
  }
  // Summary
  const totalAttempts = questions.reduce((s, q) => s + q.attempts, 0);
  const totalCorrect = questions.reduce((s, q) => s + q.correct, 0);
  const avgPct = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : null;
  const hardest = [...questions].sort((a, b) => {
    const pa = a.attempts ? a.correct / a.attempts : 1;
    const pb = b.attempts ? b.correct / b.attempts : 1;
    return pa - pb;
  })[0];
  $('analysis-summary').innerHTML = '';
  const summaryParts = [`${studentCount} student(s) with interaction data · ${qCount} question(s) tracked`];
  if (avgPct !== null) summaryParts.push(`overall ${avgPct}% correct`);
  if (hardest && hardest.attempts > 0) {
    const hp = Math.round((hardest.correct / hardest.attempts) * 100);
    summaryParts.push(`hardest: "${hardest.id}" (${hp}% correct)`);
  }
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = summaryParts.join(' · ');
  $('analysis-summary').append(p);

  // Question stats table
  const qrows = questionRows(questions);
  // Render with visual % bar
  const tbody = $('q-body');
  tbody.replaceChildren(...qrows.map((row, i) => {
    const tr = document.createElement('tr');
    row.forEach((val, ci) => {
      const td = document.createElement('td');
      if (ci === 5) { // % correct column — add visual bar
        const pctNum = questions[i].attempts ? Math.round((questions[i].correct / questions[i].attempts) * 100) : null;
        if (pctNum !== null) {
          const bar = document.createElement('div'); bar.className = 'pct-bar';
          const fill = document.createElement('div'); fill.className = 'pct-fill';
          fill.style.width = pctNum + '%';
          fill.style.background = pctNum >= 70 ? '#38796b' : pctNum >= 40 ? '#c97d10' : '#c0392b';
          bar.append(fill);
          const label = document.createElement('span'); label.textContent = pctNum + '%';
          td.append(bar, label);
        } else {
          td.textContent = '—';
        }
      } else {
        td.textContent = val ?? '—';
      }
      tr.append(td);
    });
    return tr;
  }));
  $('q-section').hidden = false;

  // Student selector for per-student answers
  const selector = $('answer-student');
  selector.replaceChildren(new Option('Select a student', ''));
  for (const [sid, {name}] of Object.entries(studentAnswers)) {
    selector.append(new Option(`${name} (${sid})`, sid));
  }
  $('student-answers-section').hidden = false;
  table($('answer-body'), []);
}

$('answer-student').onchange = () => {
  const sid = $('answer-student').value;
  if (!sid || !analysisData) { table($('answer-body'), []); return; }
  const entry = analysisData.studentAnswers[sid];
  if (!entry || !Array.isArray(entry.answers)) { table($('answer-body'), []); return; }
  const rows = studentAnswerRows(entry.answers, analysisData.questions || []);
  // Render with color coding
  const tbody = $('answer-body');
  tbody.replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    const result = row[6]; // result column
    if (result === 'correct') tr.className = 'row-correct';
    else if (result === 'wrong') tr.className = 'row-wrong';
    for (const val of row) { const td = document.createElement('td'); td.textContent = val ?? '—'; tr.append(td); }
    return tr;
  }));
};

$('export-analysis').onclick = () => {
  if (!analysisData) return message('Load analysis first.', true);
  const csv = analysisCsvText(analysisData.studentAnswers, analysisData.questions || []);
  download(new Blob(['﻿', csv], {type:'text/csv;charset=utf-8'}), 'analysis.csv');
};
