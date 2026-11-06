export function gradeRows({students, attempts}) {
  const roster = new Map(students.map(s => [s.id, {id:s.id, name:s.name, count:0}]));
  for (const a of attempts) {
    let student = roster.get(a.student_id);
    if (!student) { student = {id:a.student_id, name:a.student_name || 'Unknown student', count:0}; roster.set(student.id, student); }
    student.count++;
    if (!student.attempt) student.attempt = a;
  }
  return [...roster.values()].map(s => [s.name, s.id, s.attempt?.score ?? '', s.attempt?.status ?? 'Not attempted', s.count, s.attempt ? new Date(s.attempt.received_at).toLocaleString() : '']);
}
export function csvText(rows) {
  // Prefix formula-like cells, including those with leading whitespace.
  const cell = value => {
    const text = String(value ?? '');
    return '"' + (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
  };
  return [['Name','Student ID','Score','Status','Attempts','Last received'], ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

// Build per-question stats rows for the analysis table
// questions: array from /api/admin/analysis
export function questionRows(questions) {
  return questions.map(q => {
    const pct = q.attempts > 0 ? Math.round((q.correct / q.attempts) * 100) : null;
    // Find most common wrong answer
    const wrongResponses = Object.entries(q.responses).filter(([resp]) => {
      const cr = q.correctResponses;
      if (cr && cr.length) return !cr.includes(resp);
      return true;
    });
    wrongResponses.sort((a, b) => b[1] - a[1]);
    const topWrong = wrongResponses[0] ? `${wrongResponses[0][0]} (×${wrongResponses[0][1]})` : '';
    return [q.id, q.description || '', q.type || '', q.attempts, q.correct, pct !== null ? pct + '%' : '—', q.wrong, topWrong];
  });
}

// Build per-student answer detail rows for a given student's interactions
export function studentAnswerRows(interactions, questions) {
  const descMap = new Map(questions.map(q => [q.id, q.description]));
  return interactions.map((ix, i) => {
    const qid = ix.id !== undefined ? ix.id : String(ix.index ?? i);
    const desc = ix.description || descMap.get(qid) || '';
    const correctStr = Array.isArray(ix.correctResponses) ? ix.correctResponses.join(' / ') : '';
    const result = ix.result || '';
    return [i + 1, qid, desc, ix.type || '', ix.studentResponse ?? '', correctStr, result];
  });
}

// Export analysis as CSV: one row per student × question
export function analysisCsvText(studentAnswers, questions) {
  const cell = value => {
    const text = String(value ?? '');
    return '"' + (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
  };
  const header = ['Student Name','Student ID','Question #','Question ID','Description','Type','Answer Given','Correct Answer','Result'];
  const rows = [header];
  const descMap = new Map(questions.map(q => [q.id, q.description]));
  for (const [studentId, {name, answers}] of Object.entries(studentAnswers)) {
    if (!Array.isArray(answers)) continue;
    answers.forEach((ix, i) => {
      const qid = ix.id !== undefined ? ix.id : String(ix.index ?? i);
      const desc = ix.description || descMap.get(qid) || '';
      const correct = Array.isArray(ix.correctResponses) ? ix.correctResponses.join(' / ') : '';
      rows.push([name, studentId, i + 1, qid, desc, ix.type || '', ix.studentResponse ?? '', correct, ix.result || '']);
    });
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n');
}
