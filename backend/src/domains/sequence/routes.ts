import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import {prepareSteps,validateSequence,SequenceValidationError} from './prepare.js';
export function registerSequenceRoutes(app:Application,pool:Pool,auth:RequestHandler,write:RequestHandler){
function encodeRunCursor(createdAt:string,id:string){return Buffer.from(JSON.stringify({createdAt,id})).toString('base64url')}
function decodeRunCursor(value:string){
  try { const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8')); if(typeof decoded?.createdAt!=='string'||!Number.isFinite(Date.parse(decoded.createdAt))||typeof decoded?.id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(decoded.id))throw new Error(); return decoded as {createdAt:string;id:string}; }
  catch { throw new SequenceValidationError('VALIDATION_ERROR','无效的运行历史游标'); }
}
app.get('/api/sequences',auth,async(req,res)=>res.json((await pool.query('SELECT id,name,steps FROM sequences ORDER BY name,id')).rows));
app.get('/api/sequences/:id',auth,async(req,res)=>{
  const result=await pool.query('SELECT id,name,steps FROM sequences WHERE id=$1',[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:{code:'SEQUENCE_NOT_FOUND',message:'序列不存在',requestId:req.requestId}});
  return res.json(result.rows[0]);
});
app.post('/api/sequences',auth,write,async(req,res)=>{
  try{if(typeof req.body?.name!=='string'||!req.body.name.trim())throw new SequenceValidationError('VALIDATION_ERROR','序列名不能为空');validateSequence(req.body.steps);const result=await pool.query('INSERT INTO sequences(name,steps) VALUES($1,$2) RETURNING id',[req.body.name.trim(),JSON.stringify(req.body.steps)]);return res.json({id:result.rows[0].id})}
  catch(error){if(error instanceof SequenceValidationError)return res.status(400).json({error:{code:error.code,message:error.message,requestId:req.requestId}});throw error}
});
app.patch('/api/sequences/:id',auth,write,async(req,res)=>{
  try {
    if(typeof req.body?.name!=='string'||!req.body.name.trim())throw new SequenceValidationError('VALIDATION_ERROR','序列名不能为空');
    validateSequence(req.body.steps);
    const result=await pool.query('UPDATE sequences SET name=$2,steps=$3 WHERE id=$1 RETURNING id',[req.params.id,req.body.name.trim(),JSON.stringify(req.body.steps)]);
    if(!result.rowCount)return res.status(404).json({error:{code:'SEQUENCE_NOT_FOUND',message:'序列不存在',requestId:req.requestId}});
    return res.json({id:result.rows[0].id});
  } catch(error) {
    if(error instanceof SequenceValidationError)return res.status(400).json({error:{code:error.code,message:error.message,requestId:req.requestId}});
    throw error;
  }
});
app.post('/api/sequences/preview',auth,async(req,res)=>{
  try {
    const prepared=prepareSteps(req.body?.steps,req.body?.vars,req.body?.stepVars,req.body?.stepAccountIds);
    return res.json({steps:prepared.map(({index,accountRole,senderAccountId,text,delaySeconds,resolvedVars,varSources})=>({index,accountRole,senderAccountId,text,delaySeconds,resolvedVars,varSources}))});
  } catch(error) {
    if(error instanceof SequenceValidationError)return res.status(error.code==='UNRESOLVED_PLACEHOLDER'?422:400).json({error:{code:error.code,message:error.message,requestId:req.requestId,stepIndex:error.stepIndex,key:error.key}});
    throw error;
  }
});
app.post('/api/groups/:id/sequence-runs',auth,write,async(req,res)=>{
  const group=await pool.query('SELECT status FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  if(group.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});
  const sequence=await pool.query('SELECT * FROM sequences WHERE id=$1',[req.body?.sequenceId]);
  if(!sequence.rowCount)return res.status(404).json({error:{code:'SEQUENCE_NOT_FOUND',message:'序列不存在',requestId:req.requestId}});
  try{
    const steps=prepareSteps(sequence.rows[0].steps,req.body?.vars,req.body?.stepVars,req.body?.stepAccountIds);
    const result=await pool.query("INSERT INTO sequence_runs(group_id,sequence_id,steps,vars,status,trace_id) VALUES($1,$2,$3,$4,'running',$5) RETURNING id",[req.params.id,sequence.rows[0].id,JSON.stringify(steps),JSON.stringify(req.body?.vars||{}),req.traceId]);
    return res.status(201).json({runId:result.rows[0].id});
  }catch(error){
    if(error instanceof SequenceValidationError)return res.status(error.code==='UNRESOLVED_PLACEHOLDER'?422:400).json({error:{code:error.code,message:error.message,requestId:req.requestId,stepIndex:error.stepIndex,key:error.key}});
    if((error as {code?:string}).code==='23505')return res.status(409).json({error:{code:'SEQUENCE_ALREADY_RUNNING',message:'已有运行中的序列',requestId:req.requestId}});
    throw error;
  }
});
app.get('/api/groups/:id/sequence-runs',auth,async(req,res)=>{
  const group=await pool.query('SELECT id FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  const requestedLimit=Number(req.query.limit ?? 10);
  if(!Number.isInteger(requestedLimit)||requestedLimit<1||requestedLimit>50)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'limit 必须是 1 到 50 的整数',requestId:req.requestId}});
  const limit=requestedLimit;
  const values:any[]=[req.params.id]; let filter='';
  if(typeof req.query.sequenceId==='string'&&req.query.sequenceId){values.push(req.query.sequenceId);filter+=` AND sequence_id=$${values.length}`;}
  if(typeof req.query.before==='string'&&req.query.before){let cursor:{createdAt:string;id:string};try{cursor=decodeRunCursor(req.query.before)}catch(error){if(error instanceof SequenceValidationError)return res.status(400).json({error:{code:error.code,message:error.message,requestId:req.requestId}});throw error}values.push(cursor.createdAt,cursor.id);filter+=` AND (created_at,id)<($${values.length-1}::timestamptz,$${values.length}::uuid)`;}
  const result=await pool.query(`SELECT id,group_id AS "groupId",sequence_id AS "sequenceId",status,current_step_index AS "currentStepIndex",steps,created_at AS "createdAt",created_at::text AS "cursorCreatedAt" FROM sequence_runs WHERE group_id=$1${filter} ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`,values);
  const hasMore=result.rows.length>limit; const page=result.rows.slice(0,limit);
  const items=page.map(({cursorCreatedAt,...item})=>item);
  return res.json({items,nextCursor:hasMore?encodeRunCursor(page[page.length-1].cursorCreatedAt,page[page.length-1].id):null});
});
app.get('/api/groups/:id/sequence-runs/active',auth,async(req,res)=>{
  const group=await pool.query('SELECT id FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  const result=await pool.query('SELECT id,group_id AS "groupId",sequence_id AS "sequenceId",status,current_step_index AS "currentStepIndex",steps,created_at AS "createdAt" FROM sequence_runs WHERE group_id=$1 AND status=$2 LIMIT 1',[req.params.id,'running']);
  return res.json({run:result.rows[0]||null});
});
app.get('/api/sequence-runs/:id',auth,async(req,res)=>{const q=await pool.query('SELECT id,group_id AS "groupId",sequence_id AS "sequenceId",status,current_step_index AS "currentStepIndex",steps,created_at AS "createdAt" FROM sequence_runs WHERE id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:{code:'NOT_FOUND',message:'资源不存在',requestId:req.requestId}});res.json(q.rows[0])});
}
