import { SCHEMA_VERSION } from './infrastructure/db/version.js';
import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import http from 'http';
import { trace } from '@opentelemetry/api';
import { requests, duration, metricsText } from './infrastructure/observability/metrics.js';
import { createRealtime } from './infrastructure/realtime/websocket.js';
import { registerAuthRoutes } from './domains/auth/routes.js';
import { registerAccountRoutes } from './domains/account/routes.js';
import { registerGroupRoutes } from './domains/group/routes.js';
import { registerSequenceRoutes } from './domains/sequence/routes.js';
import { startSequenceWorker } from './domains/sequence/worker.js';
import { startAgentProcessor } from './domains/agent/processor.js';
import { startGroupJobs } from './domains/group/jobs.js';
import { startGroupJoinRequests } from './domains/group/joinRequests.js';
import { startOutbox } from './domains/message/outbox.js';
import { startMediaWorker } from './domains/message/media.js';
import { startGatewayConsumer } from './infrastructure/events/consumer.js';
import { recordTrace } from './infrastructure/observability/traces.js';
const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws'});
const pool=new Pool({connectionString:process.env.DATABASE_URL||'postgresql://sentinel:sentinel@localhost:5432/sentinel'});
const PORT=Number(process.env.PORT||4000);
const JWT_SECRET=process.env.JWT_SECRET||'dev-secret';
if(process.env.NODE_ENV==='production'&&(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32))throw new Error('JWT_SECRET must contain at least 32 characters in production');
const GATEWAY=process.env.GATEWAY_URL||'http://localhost:4001';
const AGENT=process.env.AGENT_URL||'http://localhost:4002';
const allowedOrigins=new Set((process.env.CORS_ORIGINS||'http://127.0.0.1:5173,http://localhost:5173').split(',').map(value=>value.trim()));
app.use(cors({origin:(origin,callback)=>callback(null,!origin||allowedOrigins.has(origin)),credentials:true}));

app.use(cookieParser());
const broadcast=createRealtime(pool,JWT_SECRET,wss);
app.use((req:any,res,next)=>{
  const suppliedRequestId=req.headers['x-request-id'];
  req.requestId=typeof suppliedRequestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedRequestId)?suppliedRequestId:randomUUID();
  const activeTraceId=trace.getActiveSpan()?.spanContext().traceId;
  req.traceId=(activeTraceId && !/^0+$/.test(activeTraceId)) ? activeTraceId : (typeof req.headers['x-trace-id']==='string' ? req.headers['x-trace-id'] : randomUUID());
  req.ogId=req.headers['x-og-id']||null;
  res.setHeader('x-request-id',req.requestId);
  const json=res.json.bind(res);
  res.json=(body:any)=>{
    if(res.statusCode>=400){
      const detail=body?.error||{};
      const code=res.statusCode===401?'UNAUTHORIZED':res.statusCode===403?'FORBIDDEN':detail.code||'INTERNAL_ERROR';
      body={...body,error:{...detail,...(detail.code&&detail.code!==code?{causeCode:detail.code}:{}),code,message:detail.message||'请求失败',requestId:req.requestId}};
    }
    return json(body);
  };
  res.setHeader('x-trace-id',req.traceId);
  // Persist the start marker before the handler runs so a caller can query a
  // trace immediately after receiving a response.  The finish marker below
  // adds the final status and duration asynchronously.
  void recordTrace(pool, req.traceId, 'backend', 'http_request_started', { requestId:req.requestId, method:req.method, path:req.path, userId:req.user?.sub||null });
  const started=performance.now();
  res.on('finish',()=>{
    const seconds=(performance.now()-started)/1000;
    const route=req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    requests.inc({method:req.method,route,status:String(res.statusCode)});
    duration.observe({method:req.method,route},seconds);
    console.log(JSON.stringify({event:'http_request',service:'backend',requestId:req.requestId,traceId:req.traceId,ogId:req.ogId,method:req.method,path:req.path,status:res.statusCode,durationMs:Math.round(seconds*1000),userId:req.user?.sub||null}));
    void recordTrace(pool, req.traceId, 'backend', 'http_request', { requestId:req.requestId, method:req.method, path:req.path, status:res.statusCode, durationMs:Math.round(seconds*1000), userId:req.user?.sub||null });
  });
  next();
});
app.use(express.json());
app.get('/api/metrics',async(req,res)=>{try{res.type('text/plain').send(await metricsText(pool))}catch(error){console.error(JSON.stringify({event:'metrics_failed',error:String(error)}));res.status(503).json({error:{code:'INTERNAL_ERROR',message:'指标暂时不可用',requestId:req.requestId}})}});
const {auth,write}=registerAuthRoutes(app,pool,JWT_SECRET);
app.get('/api/traces/:traceId',auth,async(req,res)=>{const traceId=String(req.params.traceId||'');if(!/^[A-Za-z0-9._:-]{8,200}$/.test(traceId))return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'无效的 trace_id',requestId:req.requestId}});const rows=await pool.query('SELECT id,trace_id AS "traceId",service,event_type AS "eventType",payload,created_at AS "createdAt" FROM trace_events WHERE trace_id=$1 ORDER BY created_at,id LIMIT 1000',[traceId]);res.json({traceId,events:rows.rows,truncated:rows.rowCount===1000})});
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,schemaVersion:SCHEMA_VERSION})}catch{res.status(503).json({ok:false,schemaVersion:'unknown',error:{code:'DATABASE_ERROR',message:'数据库不可用',requestId:req.requestId}})}});
registerAccountRoutes(app,pool,GATEWAY,broadcast,auth,write);
registerGroupRoutes(app,pool,broadcast,auth,write);
registerSequenceRoutes(app,pool,auth,write);
app.use('/api',(req:any,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'接口不存在',requestId:req.requestId}}));
app.use((error:any,req:any,res:any,_next:any)=>{
  const validation=(error instanceof SyntaxError && 'body' in error)||error?.type==='entity.too.large';
  const status=validation?400:503;
  const code=validation?'VALIDATION_ERROR':'INTERNAL_ERROR';
  console.error(JSON.stringify({event:'request_failed',requestId:req.requestId,traceId:req.traceId,error:String(error),stack:process.env.NODE_ENV==='production'?undefined:error?.stack}));
  if(!res.headersSent)res.status(status).json({error:{code,message:validation?'无效的 JSON 请求体':'服务暂时不可用',requestId:req.requestId}});
});
(async()=>{
  try{
    const schema=await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1',[SCHEMA_VERSION]);
    if(!schema.rowCount)throw new Error('schema is behind code; run npm run migrate');
    await startSequenceWorker(pool,broadcast);
    startGroupJobs({pool,gatewayUrl:GATEWAY,publish:broadcast});
    startGroupJoinRequests({pool,gatewayUrl:GATEWAY,publish:broadcast});
    startOutbox(pool,GATEWAY,broadcast);
    startMediaWorker(pool,GATEWAY);
    startAgentProcessor({pool,agentUrl:AGENT,gatewayUrl:GATEWAY,publish:broadcast});
    startGatewayConsumer({pool,gatewayUrl:GATEWAY,publish:broadcast});
    server.listen(PORT,()=>console.log(`backend listening ${PORT}`));
  }catch(error){console.error(JSON.stringify({event:'startup_failed',error:String(error)}));process.exit(1)}
})();
