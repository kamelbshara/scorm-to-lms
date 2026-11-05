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
