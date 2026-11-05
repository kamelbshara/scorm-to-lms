// Only predefined, non-secret configuration guidance may be returned to browsers.
export class SetupError extends Error {
  constructor(code, message) { super(message); this.name = 'SetupError'; this.code = code; }
}
export function startupMessage(error) {
  if (error instanceof SetupError) return error.message + ' Save Production variables in Vercel and redeploy.';
  const code = error.code || error.sourceError?.code;
  if (code === '28P01' || code === '28000') return 'Database login failed. Replace DATABASE_URL with the current Neon connection string in Vercel Production settings, then redeploy.';
  if (code === '42501') return 'Database access denied. The DATABASE_URL role needs permission to create and use the gradebook tables.';
  if (code === '3D000') return 'The configured database does not exist. Check the database selected in DATABASE_URL.';
  return 'Database initialization failed. Check DATABASE_URL in Vercel Production settings and the Neon database status, then redeploy. See Vercel Logs for the startup error code.';
}
