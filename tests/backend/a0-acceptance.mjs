import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import pg from '../../backend/node_modules/pg/lib/index.js';
const schema=`a0_check_${Date.now()}`;
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const env={...process.env,PGOPTIONS:`-c search_path=${schema},public`,PORT:'28490',GATEWAY_URL:'http://127.0.0.1:1',AGENT_URL:'http://127.0.0.1:1',NODE_OPTIONS:''};
let server;
function child(args){const p=spawn(process.execPath,args,{env});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);return {p,done:new Promise(r=>p.on('exit',code=>r({code,output}))),output:()=>output};}
async function migrate(){const r=await child(['--import','./backend/node_modules/tsx/dist/loader.mjs','backend/src/infrastructure/db/migrate.ts']).done;assert.equal(r.code,0,r.output);}
const base='http://127.0.0.1:28490';
async function req(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});const data=await r.json();if(r.status>=400){assert.equal(typeof data.error?.code,'string');assert.equal(typeof data.error?.message,'string');assert.match(data.error?.requestId,/^[a-f0-9-]{36}$/);assert.equal(data.error.requestId,r.headers.get('x-request-id'));if(r.status===401)assert.equal(data.error.code,'UNAUTHORIZED');if(r.status===403)assert.equal(data.error.code,'FORBIDDEN');}return {status:r.status,data};}
try{
 await pool.query(`CREATE SCHEMA ${schema}`);
 // Shadow the public ledger so no live version can satisfy the isolated startup check.
 await pool.query(`CREATE TABLE ${schema}.schema_migrations(version text primary key,applied_at timestamptz default now())`);
 await pool.query(`INSERT INTO ${schema}.schema_migrations(version) VALUES('1.7.0')`);
 const refused=await child(['backend/dist/index.js']).done;assert.equal(refused.code,1);assert.match(refused.output,/schema is behind code/);assert(!refused.output.includes('backend listening'));
 await migrate();
 const snapshot=async()=> (await pool.query(`SELECT username,password_hash,role FROM ${schema}.users ORDER BY username`)).rows;
 const first=await snapshot();await migrate();assert.deepEqual(await snapshot(),first);
 await Promise.all([migrate(),migrate()]);assert.deepEqual(await snapshot(),first);
 server=child(['backend/dist/index.js']);
 for(let i=0;i<60;i++){try{if((await req('/api/health')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await req('/api/health')).data.schemaVersion,'1.8.0');
 const tokens={};for(const username of ['admin','viewer']){const r=await req('/api/auth/login','POST',{username,password:username});assert.equal(r.status,200);tokens[username]=r.data.accessToken;assert.equal(typeof tokens[username],'string');const claims=JSON.parse(Buffer.from(tokens[username].split('.')[1],'base64url'));assert.equal(claims.exp-claims.iat,900);assert.equal(claims.role,username);}
 assert.equal((await req('/api/auth/login','POST','{')).status,400);
 assert.equal((await req('/api/auth/login','POST',{username:'admin',password:'wrong'})).status,401);
 assert.equal((await req('/api/accounts')).status,401);
 assert.equal((await req('/api/accounts','GET',undefined,tokens.viewer)).status,200);
 assert.equal((await req('/api/not-found')).status,404);
 let count=0;
 for(const domain of ['account','group','sequence']){const source=readFileSync(`backend/src/domains/${domain}/routes.ts`,'utf8');for(const match of source.matchAll(/app\.(post|patch|put|delete)\(\s*'([^']+)'\s*,\s*auth\s*,\s*write/g)){const path=match[2].replace(/:requestId/g,'00000000-0000-0000-0000-000000000002').replace(/:id/g,'00000000-0000-0000-0000-000000000001');assert.equal((await req(path,match[1].toUpperCase(),{},tokens.viewer)).status,403,path);count++;}}
 assert(count>=15);assert.equal((await req('/api/accounts','POST',{},tokens.admin)).status,400);
 assert.equal((await req('/api/auth/logout','POST',{},tokens.viewer)).status,200);
 assert.equal((await req('/api/accounts','GET',undefined,tokens.viewer)).status,401);
 console.log(JSON.stringify({ok:true,environment:'isolated PostgreSQL schema and Backend',gateway:env.GATEWAY_URL,agent:'not invoked',checks:['old schema refuses startup','serial and concurrent repeat migrations preserve seeds','login 15 minute access tokens','malformed JSON requestId','401/403/404 error envelope','viewer reads','admin reaches validation','logout revocation'],viewerWriteRoutes:count}));
}finally{if(server){server.p.kill('SIGTERM');const timer=setTimeout(()=>server.p.kill('SIGKILL'),1500);await server.done;clearTimeout(timer);}await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}
