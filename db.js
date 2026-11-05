import { neon } from '@neondatabase/serverless';
import pg from 'pg';
export function database(url) {
  if (!url) throw new Error('DATABASE_URL is required');
  if (new URL(url).hostname.endsWith('.neon.tech')) {
    const sql = neon(url);
    return { query: async (text, params = []) => ({ rows: await sql.query(text, params) }) };
  }
  const pool = new pg.Pool({ connectionString: url });
  return pool;
}
export async function migrate(db) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS exams (id text PRIMARY KEY, title text NOT NULL, token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS students (id text PRIMARY KEY, name text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS attempts (id text PRIMARY KEY, exam_id text NOT NULL REFERENCES exams(id), student_id text NOT NULL, student_name text NOT NULL, score double precision, status text NOT NULL, revision integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS attempts_exam_student ON attempts(exam_id, student_id)`
  ]) await db.query(sql);
}
