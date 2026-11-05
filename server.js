import express from 'express';
import { SetupError } from './setup-errors.js';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { database, migrate } from './db.js';
import { connectPackage } from './package-scorm.js';
const hash = v => createHash('sha256').update(v).digest('hex');
const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const uuid = /^[a-f0-9-]{36}$/i;
export function createApp(db, options = {}) {
  const adminKey = options.adminKey ?? process.env.ADMIN_KEY;
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL;
  if (!adminKey || adminKey.length < 24) throw new SetupError('CONFIG_ADMIN_KEY', 'ADMIN_KEY is missing or shorter than 24 characters.');
  let url;
  try { url = new URL(publicUrl); } catch {}
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new SetupError('CONFIG_PUBLIC_URL', 'PUBLIC_URL is missing or invalid. Set it to the app origin, such as https://scormrecord.vercel.app (localhost HTTP is permitted for development).');
  const origins = (options.origins ?? process.env.LMS_ORIGINS ?? 'https://lms.moe.gov.ae').split(',').map(s=>s.trim());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use('/api', (_req,res,next) => {res.setHeader('Cache-Control','no-store');next();});
  app.use('/api', rateLimit({windowMs:60000, limit:300}));
  app.use('/api/admin', rateLimit({windowMs:60000, limit:60}));
  app.use('/api/admin', (req,res,next) => {
    const key = req.get('x-admin-key') || '';
    if (!equal(key,adminKey)) return res.status(401).json({error:'Teacher access key is incorrect'});
    // Custom header authentication prevents cross-site form CSRF; no admin CORS.
    next();
  });
  app.use(express.json({limit:'1mb'}));
  // Vercel has a 4.5 MB request/response ceiling; reserve multipart overhead.
  const transferLimit = process.env.VERCEL === '1' ? 4 * 1024 * 1024 : 25 * 1024 * 1024;
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:transferLimit,files:1,fields:2}});
  app.get('/health', async (_req,res) => {try {await db.query('SELECT 1');res.json({status:'ok'});} catch {res.status(503).json({status:'database unavailable'});}});
  app.post('/api/admin/packages', upload.single('package'), async (req,res) => {
    if (!req.file || !req.body.title?.trim() || req.body.title.length > 200) return res.status(400).json({error:'Provide a title (up to 200 characters) and SCORM ZIP'});
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    let zip;
    try {zip = connectPackage(req.file.buffer, {examId:id,token,endpoint:publicUrl.replace(/\/$/,'')+'/api/results'});} catch(e) {return res.status(400).json({error:e.message});}
    if (zip.length > transferLimit) return res.status(413).json({error:'Connected ZIP exceeds the hosting transfer limit; use Railway for larger packages'});
    await db.query('INSERT INTO exams(id,title,token_hash) VALUES($1,$2,$3)',[id,req.body.title.trim(),hash(token)]);
    res.setHeader('Content-Disposition',`attachment; filename="scorm-${id}.zip"`);
    res.type('application/zip').send(zip);
  });
  app.get('/api/admin/exams', async (_req,res) => res.json((await db.query('SELECT id,title,created_at FROM exams ORDER BY created_at DESC')).rows));
  app.post('/api/admin/roster', express.text({type:'text/csv',limit:'1mb'}), async (req,res) => {
    let rows;
    try {rows = parse(req.body, {columns:true,skip_empty_lines:true,bom:true,trim:true});} catch {return res.status(400).json({error:'Invalid CSV; expected student_id,name headers'});}
    if (!rows.length || rows.length > 5000 || rows.some(r=>!r.student_id || !r.name || r.student_id.length>200 || r.name.length>200)) return res.status(400).json({error:'CSV needs student_id,name columns; maximum 5000 rows, 200 characters per value'});
    // One statement makes the roster import atomic on Neon HTTP as well as pg.
    const unique = [...new Map(rows.map(r=>[r.student_id,r])).values()];
    const params = unique.flatMap(r=>[r.student_id,r.name]);
    const values = unique.map((_,i)=>`($${2*i+1},$${2*i+2})`).join(',');
    await db.query(`INSERT INTO students(id,name) VALUES ${values} ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name`, params);
    res.json({imported:unique.length});
  });
  app.get('/api/admin/grades', async (req,res) => {
    if (!uuid.test(req.query.examId ?? '')) return res.status(400).json({error:'Select an exam'});
    const students = (await db.query('SELECT id,name FROM students ORDER BY name')).rows;
    const attempts = (await db.query('SELECT id,student_id,student_name,score,status,revision,received_at FROM attempts WHERE exam_id=$1 ORDER BY received_at DESC',[req.query.examId])).rows;
    res.json({students,attempts});
  });
  app.use('/api/results', (req,res,next) => {
    const origin=req.get('origin');
    if (origin && !origins.includes(origin)) return res.status(403).json({error:'LMS origin is not allowed'});
    if (origin) {res.setHeader('Access-Control-Allow-Origin',origin);res.vary('Origin');}
    if(req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');return res.sendStatus(204);}
    next();
  });
  app.post('/api/results', express.text({type:'text/plain',limit:'16kb'}), async (req,res) => {
    let e; try {e = typeof req.body==='string' ? JSON.parse(req.body) : req.body;} catch {return res.status(400).json({error:'Invalid JSON'});}
    const statuses = ['passed','completed','failed','incomplete','browsed','not attempted'];
    if (!e || !uuid.test(e.examId ?? '') || !uuid.test(e.attemptId ?? '') || typeof e.token!=='string' || e.token.length!==64 || !Number.isInteger(e.revision) || e.revision<1 || e.revision>2147483647 || typeof e.studentId!=='string' || !e.studentId.trim() || e.studentId.length>200 || typeof e.studentName!=='string' || e.studentName.length>200 || !statuses.includes(e.status) || !(e.score===null || (typeof e.score==='number' && Number.isFinite(e.score) && e.score>=0 && e.score<=100))) return res.status(400).json({error:'Invalid result fields (score must be 0–100 or null)'});
    const exam=(await db.query('SELECT token_hash FROM exams WHERE id=$1',[e.examId])).rows[0];
    if(!exam || !equal(hash(e.token),exam.token_hash)) return res.status(401).json({error:'Invalid exam token'});
    await db.query(`INSERT INTO attempts(id,exam_id,student_id,student_name,score,status,revision) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET student_name=EXCLUDED.student_name,score=EXCLUDED.score,status=EXCLUDED.status,revision=EXCLUDED.revision,received_at=now()
      WHERE attempts.exam_id=EXCLUDED.exam_id AND attempts.student_id=EXCLUDED.student_id AND attempts.revision < EXCLUDED.revision RETURNING id`,[e.attemptId,e.examId,e.studentId,e.studentName,e.score,e.status,e.revision]);
    // Old revisions and duplicate retries are deliberately acknowledged.
    res.json({saved:true});
  });
  app.use(express.static(fileURLToPath(new URL('./public',import.meta.url))));
  app.use((err,_req,res,_next) => {const uploadError=err instanceof multer.MulterError;const clientError=uploadError || err.status===400 || err.status===413; if(!clientError) console.error('Request failed:',err.code || err.name);res.status(clientError ? (err.status || 400) : 500).json({error:uploadError?'Upload exceeds limits':clientError?'Invalid request body':'Request failed; please retry'});});
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = database(process.env.DATABASE_URL);
  await migrate(db);
  createApp(db).listen(process.env.PORT || 3000,'0.0.0.0',()=>console.log('SCORM gradebook listening'));
}
