import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import {prepareSteps,validateSequence,SequenceValidationError} from './prepare.js';
export function registerSequenceRoutes(app:Application,pool:Pool,auth:RequestHandler,write:RequestHandler){
app.get('/api/sequences',auth,async(req,res)=>res.json((await pool.query('SELECT id,name,steps FROM sequences ORDER BY name,id')).rows));
app.post('/api/sequences',auth,write,async(req,res)=>{
  try{if(typeof req.body?.name!=='string'||!req.body.name.trim())throw new SequenceValidationError('VALIDATION_ERROR','序列名不能为空');validateSequence(req.body.steps);const result=await pool.query('INSERT INTO sequences(name,steps) VALUES($1,$2) RETURNING id',[req.body.name.trim(),JSON.stringify(req.body.steps)]);return res.json({id:result.rows[0].id})}
  catch(error){if(error instanceof SequenceValidationError)return res.status(400).json({error:{code:error.code,message:error.message,requestId:req.requestId}});throw error}
});
app.post('/api/groups/:id/sequence-runs',auth,write,async(req,res)=>{
  const group=await pool.query('SELECT status FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  if(group.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});
  const sequence=await pool.query('SELECT * FROM sequences WHERE id=$1',[req.body?.sequenceId]);
  if(!sequence.rowCount)return res.status(404).json({error:{code:'SEQUENCE_NOT_FOUND',message:'序列不存在',requestId:req.requestId}});
  try{
    const steps=prepareSteps(sequence.rows[0].steps,req.body?.vars,req.body?.stepVars);
    const result=await pool.query("INSERT INTO sequence_runs(group_id,sequence_id,steps,vars,status) VALUES($1,$2,$3,$4,'running') RETURNING id",[req.params.id,sequence.rows[0].id,JSON.stringify(steps),JSON.stringify(req.body?.vars||{})]);
    return res.status(201).json({runId:result.rows[0].id});
  }catch(error){
    if(error instanceof SequenceValidationError)return res.status(error.code==='UNRESOLVED_PLACEHOLDER'?422:400).json({error:{code:error.code,message:error.message,requestId:req.requestId,stepIndex:error.stepIndex,key:error.key}});
    if((error as {code?:string}).code==='23505')return res.status(409).json({error:{code:'SEQUENCE_ALREADY_RUNNING',message:'已有运行中的序列',requestId:req.requestId}});
    throw error;
  }
});
app.get('/api/sequence-runs/:id',auth,async(req,res)=>{const q=await pool.query('select * from sequence_runs where id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:{code:'NOT_FOUND',message:'资源不存在',requestId:req.requestId}});const row=q.rows[0];res.json({id:row.id,status:row.status,currentStepIndex:row.current_step_index,steps:row.steps})});
}
