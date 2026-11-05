function connector(config) {
  'use strict';
  // Runs in the LMS origin. No database or teacher credentials are packaged.
  try { for (let w = window.parent, n = 0; w && w !== window && n < 20; n++, w = w.parent) { if (w.__gradebookConnected) return; if (w.parent === w) break; } } catch {}
  if (window.__gradebookConnected) return;
  window.__gradebookConnected = true;
  let api;
  function find(w) {
    for (let n = 0; w && n < 20; n++) {
      try { if (w.API && !w.API.__gradebookProxy) return w.API; if (w.parent === w) break; w = w.parent; } catch { break; }
    }
  }
  api = find(window.parent);
  if (!api) { try { api = find(window.opener); } catch {} }
  if (!api) { console.warn('Gradebook: LMS SCORM 1.2 API unavailable; results cannot be linked.'); return; }
  const methods = ['LMSInitialize','LMSFinish','LMSGetValue','LMSSetValue','LMSCommit','LMSGetLastError','LMSGetErrorString','LMSGetDiagnostic'];
  const original = api.__gradebookOriginal || {};
  for (const method of methods) if (!original[method] && typeof api[method] === 'function') original[method] = api[method].bind(api);
  if (!original.LMSGetValue || !original.LMSSetValue) return;
  const prefix = 'scorm-gradebook:' + config.examId + ':';
  try { api.__gradebookOriginal = original; } catch {}
  let memory = [], storageAvailable = true, flushing = false, attempt, lastSignature, ended = false;
  function notify(message) { console.warn('Gradebook: ' + message); }
  function readQueue() {
    if (!storageAvailable) return memory;
    try { const queue = JSON.parse(localStorage.getItem(prefix + 'queue') || '[]'); return Array.isArray(queue) ? queue : memory; } catch { storageAvailable = false; return memory; }
  }
  function writeQueue(queue) {
    memory = queue;
    try { localStorage.setItem(prefix + 'queue', JSON.stringify(queue)); } catch { storageAvailable = false; notify('browser storage unavailable; keep this window open until synced.'); }
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const event of readQueue()) {
        const response = await fetch(config.endpoint, { method: 'POST', headers: {'Content-Type':'text/plain'}, body: JSON.stringify(event), credentials: 'omit', keepalive: true });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        // Remove only the acknowledged event; preserve newly queued snapshots.
        writeQueue(readQueue().filter(e => !(e.attemptId === event.attemptId && e.revision === event.revision)));
      }
    } catch { notify('results pending; retrying while this exam is open.'); }
    finally { flushing = false; }
  }
  function capture(finish) {
    if (ended) return;
    try {
      const studentId = String(original.LMSGetValue('cmi.core.student_id') || '');
      if (!studentId) { notify('LMS student ID missing; result was not submitted.'); return; }
      const studentName = String(original.LMSGetValue('cmi.core.student_name') || '');
      const value = original.LMSGetValue('cmi.core.score.raw');
      const score = value === '' ? null : Number(value);
      const status = String(original.LMSGetValue('cmi.core.lesson_status') || 'not attempted');
      const key = prefix + studentId + ':attempt';
      if (!attempt || attempt.studentId !== studentId) {
        try { attempt = JSON.parse(sessionStorage.getItem(key)); } catch {}
        if (!attempt || attempt.studentId !== studentId) attempt = { id: crypto.randomUUID(), revision: 0, studentId };
      }
      const signature = JSON.stringify([studentId, studentName, score, status]);
      if (signature !== lastSignature || finish) {
        attempt.revision++;
        const event = { token: config.token, examId: config.examId, attemptId: attempt.id, revision: attempt.revision, studentId, studentName, score: Number.isFinite(score) ? score : null, status };
        const queue = readQueue().filter(e => e.attemptId !== attempt.id);
        queue.push(event); writeQueue(queue);
        lastSignature = signature;
        try { sessionStorage.setItem(key, JSON.stringify(attempt)); } catch {}
      }
      if (finish) { try { sessionStorage.removeItem(key); } catch {} attempt = null; lastSignature = null; ended = true; }
      void flush();
    } catch (e) { notify('could not capture result: ' + e.message); }
  }
  const proxy = { __gradebookProxy: true };
  for (const method of methods) {
    if (!original[method]) continue;
    proxy[method] = function(...args) {
      // Read before Finish: many runtimes disallow reads after termination.
      if (method === 'LMSInitialize') ended = false;
      if (method === 'LMSFinish') capture(true);
      const result = original[method](...args);
      if (String(result) === 'true' && ['LMSInitialize','LMSSetValue','LMSCommit'].includes(method)) capture(false);
      return result;
    };
    try { api[method] = proxy[method]; } catch {}
  }
  window.API = proxy;
  window.addEventListener('online', flush);
  window.addEventListener('pagehide', () => capture(false));
  setInterval(flush, 15000);
  void flush();
}
