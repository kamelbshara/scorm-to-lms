function connector(config) {
  'use strict';
  // Runs in the LMS origin. No database or teacher credentials are packaged.
  try {
    for (let w = window.parent, n = 0; w && w !== window && n < 20; n++, w = w.parent) {
      if (w.__gradebookConnected) return;
      if (w.parent === w) break;
    }
  } catch {}
  if (window.__gradebookConnected) return;
  let api;
  function find(w) {
    for (let n = 0; w && n < 20; n++) {
      try { if (w.API && !w.API.__gradebookProxy) return w.API; if (w.parent === w) break; w = w.parent; } catch { break; }
    }
  }
  api = find(window.parent);
  if (!api) { try { api = find(window.opener); } catch {} }
  let lastNotice;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { if (lastNotice) notice(...lastNotice); });
  function notice(message, state = 'pending') {
    lastNotice = [message, state];
    try {
      if (typeof document === 'undefined') return;
      let badge = document.getElementById('scorm-gradebook-status');
      if (!document.body) return;
      if (!badge) {
        badge = document.createElement('div'); badge.id = 'scorm-gradebook-status';
        badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
        Object.assign(badge.style, {position:'fixed',bottom:'8px',right:'8px',zIndex:'2147483647',maxWidth:'320px',padding:'8px 12px',borderRadius:'6px',font:'13px system-ui',boxShadow:'0 1px 8px #0003'});
        document.body.appendChild(badge);
      }
      badge.textContent = message;
      badge.style.background = state === 'saved' ? '#e0f3e5' : '#fff0ce'; badge.style.color = '#193a36';
    } catch {}
  }
  function notify(message) { console.warn('Gradebook: ' + message); notice(message); }
  if (!api) { notify('Student connection unavailable. Please contact your teacher.'); return; }
  const methods = ['LMSInitialize','LMSFinish','LMSGetValue','LMSSetValue','LMSCommit','LMSGetLastError','LMSGetErrorString','LMSGetDiagnostic'];
  const original = api.__gradebookOriginal || {};
  for (const method of methods) if (!original[method] && typeof api[method] === 'function') original[method] = api[method].bind(api);
  if (!original.LMSGetValue || !original.LMSSetValue) return;
  window.__gradebookConnected = true;
  const prefix = 'scorm-gradebook:' + config.examId + ':';
  try { api.__gradebookOriginal = original; } catch {}
  let memory = new Map(), storageAvailable = true, flushing = false, attempt, lastSignature, ended = false, initialized = false, captureProblem = false;
  let lastError;
  const eventKey = event => prefix + 'pending:' + event.attemptId + ':' + event.revision;
  function readQueue() {
    const entries = new Map(memory);
    if (storageAvailable) {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(prefix + 'pending:')) continue;
          try { const e = JSON.parse(localStorage.getItem(key)); if (e && e.examId === config.examId) entries.set(key, e); } catch {}
        }
      } catch { storageAvailable = false; }
    }
    return entries;
  }
  function enqueue(event) {
    const existing = readQueue();
    const key = eventKey(event); memory.set(key, event);
    if (!storageAvailable) return;
    try {
      localStorage.setItem(key, JSON.stringify(event));
      // Separate immutable revision keys prevent another tab's newer result being deleted by an old acknowledgement.
      memory.delete(key);
      for (const [older, e] of readQueue()) if (e.attemptId === event.attemptId && e.revision < event.revision) {
        localStorage.removeItem(older); memory.delete(older);
      }
    } catch { memory = new Map([...existing, ...memory]); memory.set(key, event); storageAvailable = false; notify('Results are waiting to sync. Keep this exam open; browser storage is unavailable.'); }
  }
  // Preserve pending results from connector versions that used a single queue array.
  try {
    const legacy = JSON.parse(localStorage.getItem(prefix + 'queue') || '[]');
    if (Array.isArray(legacy)) for (const e of legacy) if (e && e.examId === config.examId) enqueue(e);
    if (storageAvailable) localStorage.removeItem(prefix + 'queue');
  } catch {}
  async function flush() {
    if (flushing) return;
    flushing = true;
    let acknowledged = false;
    try {
      for (const [key, event] of readQueue()) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(config.endpoint, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(event), credentials:'omit', keepalive:true, signal:controller.signal });
          // A login page or proxy response is not a database acknowledgement.
          const result = response.ok ? await response.json() : null;
          if (!response.ok || result?.saved !== true) throw new Error('Not acknowledged');
          acknowledged = true;
          memory.delete(key);
          try { localStorage.removeItem(key); } catch {}
        } catch { notify('Results are waiting to sync. Keep this exam open and check your connection.'); }
        finally { clearTimeout(timeout); }
      }
      if (acknowledged && !captureProblem && readQueue().size === 0) notice('Results saved', 'saved');
    } finally { flushing = false; }
  }
  function snapshot() {
    const studentId = String(original.LMSGetValue('cmi.core.student_id') || '').trim();
    if (!studentId) { captureProblem = true; notify('Student ID unavailable. Please contact your teacher.'); return; }
    captureProblem = false;
    const studentName = String(original.LMSGetValue('cmi.core.student_name') || '');
    const value = original.LMSGetValue('cmi.core.score.raw');
    const numeric = value === '' ? null : Number(value);
    const score = Number.isFinite(numeric) ? numeric : null;
    const status = String(original.LMSGetValue('cmi.core.lesson_status') || 'not attempted');
    return {studentId, studentName, score, status};
  }
  function capture(values, finish = false) {
    if (ended || !initialized || !values) return;
    try {
      const key = prefix + values.studentId + ':attempt';
      if (!attempt || attempt.studentId !== values.studentId) {
        try { attempt = JSON.parse(sessionStorage.getItem(key)); } catch {}
        if (!attempt || attempt.studentId !== values.studentId || typeof attempt.id !== 'string' || !Number.isInteger(attempt.revision)) attempt = { id:crypto.randomUUID(), revision:0, studentId:values.studentId };
      }
      const signature = JSON.stringify(values);
      if (signature !== lastSignature || finish) {
        attempt.revision++;
        enqueue({token:config.token,examId:config.examId,attemptId:attempt.id,revision:attempt.revision,...values});
        lastSignature = signature;
        try { sessionStorage.setItem(key, JSON.stringify(attempt)); } catch {}
      }
      if (finish) { try { sessionStorage.removeItem(key); } catch {} attempt = null; lastSignature = null; ended = true; initialized = false; }
      void flush();
    } catch { notify('Result capture failed. Keep the exam open and contact your teacher.'); }
  }
  function readSnapshot() { try { return snapshot(); } catch { captureProblem = true; notify('Could not read the exam result. Please contact your teacher.'); } }
  const proxy = { __gradebookProxy:true };
  for (const method of methods) {
    if (!original[method]) continue;
    proxy[method] = function(...args) {
      // Read before Finish (some LMSs reject reads after termination), but close the attempt only if Finish succeeds.
      const finalValues = method === 'LMSFinish' && initialized ? readSnapshot() : undefined;
      if (method === 'LMSGetLastError' && lastError !== undefined) return lastError;
      const result = original[method](...args);
      if (original.LMSGetLastError && !['LMSGetLastError','LMSGetErrorString','LMSGetDiagnostic'].includes(method)) {
        try { lastError = original.LMSGetLastError(); } catch {}
      }
      if (String(result).toLowerCase() === 'true') {
        if (method === 'LMSInitialize') { ended = false; initialized = true; }
        if (method === 'LMSFinish') capture(finalValues, true);
        else if (initialized && (method === 'LMSInitialize' || method === 'LMSCommit' || (method === 'LMSSetValue' && ['cmi.core.score.raw','cmi.core.lesson_status'].includes(args[0])))) capture(readSnapshot());
      }
      return result;
    };
    try { api[method] = proxy[method]; } catch {}
  }
  window.API = proxy;
  window.addEventListener('online', flush);
  window.addEventListener('pagehide', () => { if (initialized) capture(readSnapshot()); });
  setInterval(flush, 15000);
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { if (readQueue().size) notice('Results are waiting to sync. Keep this exam open.'); });
  void flush();
}
