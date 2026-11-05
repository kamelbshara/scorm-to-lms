import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { migrate } from '../db.js';
const key='test-teacher-key-at-least-24-characters';
const manifest=`<?xml version="1.0"?><manifest xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata><resources><resource identifier="sco" adlcp:scormtype="sco" href="index.html" type="webcontent"><file href="index.html"/></resource></resources></manifest>`;
async function setup(){const mem=newDb();const {Pool}=mem.adapters.createPg();const db=new Pool();await migrate(db);return {db,app:createApp(db,{adminKey:key,publicUrl:'https://grades.example.org'})};}
function zip(xml=manifest){const z=new AdmZip();z.addFile('imsmanifest.xml',Buffer.from(xml));z.addFile('index.html',Buffer.from('<html><head></head><body>Exam</body></html>'));return z.toBuffer();}
async function upload(app){return request(app).post('/api/admin/packages').set('x-admin-key',key).field('title','Science Test').attach('package',zip(),'exam.zip').buffer(true).parse((res,callback)=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>callback(null,Buffer.concat(chunks)));});}
test('teacher auth protects all grade and roster endpoints',async()=>{const {app}=await setup();for(const path of ['exams','grades'])assert.equal((await request(app).get('/api/admin/'+path)).status,401);assert.equal((await request(app).get('/health')).body.status,'ok');});
test('ZIP → collector → database → gradebook; retries and stale snapshots cannot overwrite grades',async()=>{
  const {app}=await setup();const uploaded=await upload(app);assert.equal(uploaded.status,200);
  const html=new AdmZip(uploaded.body).readAsText('index.html');assert.match(html,/data-scorm-gradebook/);
  const examId=html.match(/"examId":"([^"]+)"/)[1], token=html.match(/"token":"([^"]+)"/)[1];
  const event={examId,token,attemptId:randomUUID(),revision:2,studentId:'s1',studentName:'A Student',score:91,status:'passed'};
  const send=e=>request(app).post('/api/results').set('Origin','https://lms.moe.gov.ae').set('Content-Type','text/plain').send(JSON.stringify(e));
  assert.equal((await send(event)).status,200);
  assert.equal((await send(event)).body.saved,true);
  assert.equal((await send({...event,revision:1,score:10})).body.saved,true);
  const roster=await request(app).post('/api/admin/roster').set('x-admin-key',key).set('Content-Type','text/csv').send('student_id,name\ns1,A Student\ns2,Not Attempted\n');assert.equal(roster.status,200);assert.equal(roster.body.imported,2);
  const grade=await request(app).get('/api/admin/grades?examId='+examId).set('x-admin-key',key);assert.equal(grade.status,200);assert.equal(grade.body.students.length,2);assert.equal(grade.body.attempts.length,1);assert.equal(grade.body.attempts[0].score,91);
  assert.equal((await send({...event,token:'x'.repeat(64)})).status,401);
  assert.equal((await send({...event,score:200})).status,400);
  assert.equal((await send({...event,studentId:''})).status,400);
  assert.equal((await request(app).post('/api/results').set('Origin','https://evil.example').set('Content-Type','text/plain').send(JSON.stringify(event))).status,403);
  assert.equal((await request(app).get('/api/admin/exams').set('x-admin-key',key)).body[0].token_hash,undefined);
});
test('invalid ZIPs and unsupported multi-SCO packages are rejected without registering an exam',async()=>{
  const {app}=await setup();
  for(const buffer of [Buffer.from('not a zip'),zip(manifest.replace('</resources>','<resource adlcp:scormtype="sco" href="two.html"/></resources>'))]){
    assert.equal((await request(app).post('/api/admin/packages').set('x-admin-key',key).field('title','Bad').attach('package',buffer,'bad.zip')).status,400);
  }
  assert.equal((await request(app).get('/api/admin/exams').set('x-admin-key',key)).body.length,0);
});

test('Vercel handler serves the dashboard and initialized database API without a listener', async()=>{
  const {handlerFor}=await import('../api/index.js');
  const mem=newDb();const {Pool}=mem.adapters.createPg();const db=new Pool();let connects=0;
  const handler=handlerFor({connect:()=>{connects++;return db;},appOptions:{adminKey:key,publicUrl:'https://grades.example.org'}});
  const home=await request(handler).get('/');assert.equal(home.status,200);assert.match(home.text,/SCORM Gradebook/);
  assert.equal((await request(handler).get('/health')).body.status,'ok');
  assert.deepEqual((await request(handler).get('/api/admin/exams').set('x-admin-key',key)).body,[]);
  assert.equal(connects,1);
});
