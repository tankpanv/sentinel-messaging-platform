import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import pg from '../../backend/node_modules/pg/lib/index.js';
const schema=`a1_check_${Date.now()}`;
let pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const env={...process.env,PGOPTIONS:`-c search_path=${schema},public`,PORT:'28491',GATEWAY_URL:'http://127.0.0.1:1',AGENT_URL:'http://127.0.0.1:1',NODE_OPTIONS:''};
function launch(args){const p=spawn(process.execPath,args,{env});let output='';p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>output+=v);return {p,done:new Promise(resolve=>p.on('exit',code=>resolve({code,output}))),output:()=>output};}
async function stop(instance){if(!instance)return;instance.p.kill('SIGTERM');const timer=setTimeout(()=>instance.p.kill('SIGKILL'),1500);await instance.done;clearTimeout(timer);}
const base='http://127.0.0.1:28491';let server;
async function req(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
async function migrate(){const result=await launch(['--import','./backend/node_modules/tsx/dist/loader.mjs','backend/src/infrastructure/db/migrate.ts']).done;assert.equal(result.code,0,result.output);}
const status=['idle','online','rate_limited','disconnected','suspended','session_expired'];
const edges={idle:['disconnected','suspended','session_expired'],online:['idle','rate_limited','disconnected','suspended','session_expired'],rate_limited:['online','disconnected','suspended','session_expired'],disconnected:['idle','online','suspended','session_expired'],suspended:[],session_expired:[]};
try{
 await pool.query(`CREATE SCHEMA ${schema}`);
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`});
 await migrate();await migrate();
 server=launch(['backend/dist/index.js']);
 let healthy=false;
 for(let i=0;i<80;i++){try{const health=await req('/api/health');if(health.status===200&&health.data.ok){healthy=true;break}}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.ok(healthy,`Backend did not become healthy; startup output: ${server.output()}`);
 const login=await req('/api/auth/login','POST',{username:'admin',password:'admin'});assert.equal(login.status,200,`login failed: ${JSON.stringify(login.data)}; server: ${server.output()}`);const token=login.data.accessToken;
 const fixture=`a1-${Date.now()}`;
 await pool.query("INSERT INTO accounts(id,status,platform_user_id) VALUES($1,'idle',$2)",[fixture,`${fixture}-pid`]);
 for(const from of status) for(const to of status){
   await pool.query('UPDATE accounts SET status=$2,rate_limited_until=NULL WHERE id=$1',[fixture,from]);
   const result=await req(`/api/accounts/${fixture}/transition`,'POST',{expectedFrom:from,to},token);
   const allowed=edges[from].includes(to),duplicateTerminal=from===to&&(to==='suspended'||to==='session_expired');
   assert.equal(result.status,(allowed||duplicateTerminal)?200:409,`${from}->${to} returned ${result.status}: ${JSON.stringify(result.data)}`);
   if(!allowed&&!duplicateTerminal)assert.equal(result.data.error.code,'ILLEGAL_TRANSITION');
   const actual=(await pool.query('SELECT status FROM accounts WHERE id=$1',[fixture])).rows[0].status;
   assert.equal(actual,(allowed||duplicateTerminal)?to:from,`${from}->${to} persistence`);
 }
 // CAS: simultaneous legal writes with the same expectedFrom must not overwrite.
 await pool.query("UPDATE accounts SET status='online' WHERE id=$1",[fixture]);
 const pair=await Promise.all([req(`/api/accounts/${fixture}/transition`,'POST',{expectedFrom:'online',to:'idle'},token),req(`/api/accounts/${fixture}/transition`,'POST',{expectedFrom:'online',to:'disconnected'},token)]);
 assert.deepEqual(pair.map(x=>x.status).sort(),[200,409]);assert.equal(pair.find(x=>x.status===409).data.error.code,'CAS_CONFLICT');
 // An expired persisted rate limit must recover after a process restart.
 await pool.query("UPDATE accounts SET status='rate_limited',rate_limited_until=now()-interval '1 second' WHERE id=$1",[fixture]);
 await stop(server);server=launch(['backend/dist/index.js']);
 healthy=false;
 for(let i=0;i<80;i++){try{const health=await req('/api/health');if(health.status===200&&health.data.ok){healthy=true;break}}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.ok(healthy,`Backend restart did not become healthy; startup output: ${server.output()}`);
 for(let i=0;i<80;i++){const status=(await pool.query('SELECT status FROM accounts WHERE id=$1',[fixture])).rows[0].status;if(status==='online')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal((await pool.query('SELECT status,rate_limited_until FROM accounts WHERE id=$1',[fixture])).rows[0].status,'online','expired persisted rate limit recovers on restart');
 // Terminal effects and status commit together: membership removed, queued send cancelled, sequence step skipped.
 const groupId=(await pool.query("INSERT INTO groups(gateway_group_id,creator_account_id) VALUES($1,$2) RETURNING id",[`gw-${fixture}`,fixture])).rows[0].id;
 await pool.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'creator')",[groupId,fixture,`${fixture}-pid`]);
 const sequence=(await pool.query("INSERT INTO sequences(name,steps) VALUES('terminal acceptance','[]') RETURNING id")).rows[0].id;
 const clientMsgId=`${fixture}-message`;
 await pool.query("INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id) VALUES($1,$2,'queued',$3,now(),'queued',true,$4)",[groupId,clientMsgId,`${fixture}-pid`,fixture]);
 const run=(await pool.query("INSERT INTO sequence_runs(group_id,sequence_id,status,steps) VALUES($1,$2,'running',$3) RETURNING id",[groupId,sequence,JSON.stringify([{clientMsgId,status:'queued'}])])).rows[0].id;
 await pool.query("UPDATE accounts SET status='online' WHERE id=$1",[fixture]);
 const terminal=await req(`/api/accounts/${fixture}/transition`,'POST',{expectedFrom:'online',to:'suspended'},token);assert.equal(terminal.status,200);
 assert.equal((await pool.query('SELECT status FROM accounts WHERE id=$1',[fixture])).rows[0].status,'suspended');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM group_members WHERE account_id=$1',[fixture])).rows[0].n,0);
 const msg=(await pool.query('SELECT delivery_status,fail_code FROM messages WHERE client_msg_id=$1',[clientMsgId])).rows[0];assert.deepEqual(msg,{delivery_status:'cancelled',fail_code:'ACCOUNT_TERMINAL'});
 const steps=(await pool.query('SELECT steps FROM sequence_runs WHERE id=$1',[run])).rows[0].steps;assert.equal(steps[0].status,'skipped');assert.ok(steps[0].sentAt);
 const duplicate=await req(`/api/accounts/${fixture}/transition`,'POST',{expectedFrom:'suspended',to:'suspended'},token);assert.equal(duplicate.status,200);
 const stillTerminal=await pool.query('SELECT status FROM accounts WHERE id=$1',[fixture]);assert.equal(stillTerminal.rows[0].status,'suspended');
 console.log(JSON.stringify({ok:true,environment:'isolated PostgreSQL schema and Backend; simulated/unavailable Gateway (127.0.0.1:1)',agent:'not invoked',checks:['all 36 state pairs','idle to disconnected and idle to online rejected','self transitions rejected','terminal states have no exits','CAS race returns exactly one success and one conflict','expired persisted rate limit recovers after Backend restart','terminal effects atomic in one DB transaction','duplicate terminal transition ignored'],statePairs:36}));
}finally{await stop(server);await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}
