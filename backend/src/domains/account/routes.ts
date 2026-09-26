import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import {AccountTransitionError,transitionAccount,isTerminal,type AccountStatus} from './state.js';
export function registerAccountRoutes(app:Application,pool:Pool,GATEWAY:string,broadcast:(type:string,payload:any)=>void,auth:RequestHandler,write:RequestHandler){
app.get('/api/accounts',auth,async(req,res)=>res.json((await pool.query('select id,status,platform_user_id as "platformUserId",rate_limited_until as "rateLimitedUntil" from accounts order by id')).rows));
app.post('/api/accounts/:id/connect',auth,write,async(req,res)=>{
  const id=String(req.params.id);
  const row=(await pool.query('SELECT status,platform_user_id FROM accounts WHERE id=$1',[id])).rows[0];
  if(!row)return res.status(404).json({error:{code:'ACCOUNT_NOT_FOUND',message:'账号不存在',requestId:req.requestId}});
  if(isTerminal(row.status))return res.status(409).json({error:{code:'ILLEGAL_TRANSITION',message:'终态账号不可重连',requestId:req.requestId}});
  if(!['idle','disconnected'].includes(row.status))return res.status(409).json({error:{code:'ILLEGAL_TRANSITION',message:'当前状态不可重连',requestId:req.requestId}});
  try{
    const gatewayResponse=await fetch(`${GATEWAY}/accounts/${id}/connect`,{method:'POST'});
    if(!gatewayResponse.ok){const body:any=await gatewayResponse.json().catch(()=>({}));if(body.code==='ACCOUNT_SUSPENDED'||body.code==='SESSION_EXPIRED'){const status=body.code==='ACCOUNT_SUSPENDED'?'suspended':'session_expired';const result=await transitionAccount(pool,id,status,{allowSameTerminal:true});if(result.changed)broadcast('account_terminal',{accountId:id,status})}return res.status(gatewayResponse.status).json({error:{code:body.code||'GATEWAY_ERROR',message:'网关连接失败',requestId:req.requestId}})}
    const body:any=await gatewayResponse.json();
    const result=await transitionAccount(pool,id,'online',{expectedFrom:row.status,platformUserId:body.platformUserId});
    broadcast('account_status_changed',{accountId:id,from:result.from,to:'online'});
    return res.json({status:'online',platformUserId:body.platformUserId});
  }catch(error){if(error instanceof AccountTransitionError)return res.status(error.code==='ACCOUNT_NOT_FOUND'?404:409).json({error:{code:error.code,message:error.message,requestId:req.requestId}});throw error}
});
app.post('/api/accounts/:id/transition',auth,write,async(req,res)=>{
  const {to,expectedFrom}=req.body||{};
  if(typeof to!=='string'||typeof expectedFrom!=='string')return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'to 和 expectedFrom 必填',requestId:req.requestId}});
  try{
    const result=await transitionAccount(pool,String(req.params.id),to as AccountStatus,{expectedFrom:expectedFrom as AccountStatus});
    if(to==='disconnected'||to==='idle'){
      try{const response=await fetch(`${GATEWAY}/accounts/${req.params.id}/disconnect`,{method:'POST'});if(!response.ok)broadcast('inconsistency',{kind:'gateway_disconnect',ref:req.params.id,message:`Gateway returned ${response.status}`})}
      catch(error){broadcast('inconsistency',{kind:'gateway_disconnect',ref:req.params.id,message:String(error)})}
    }
    broadcast(isTerminal(to)?'account_terminal':'account_status_changed',{accountId:req.params.id,from:result.from,to,status:to});
    return res.json({status:to});
  }catch(error){if(error instanceof AccountTransitionError)return res.status(error.code==='ACCOUNT_NOT_FOUND'?404:409).json({error:{code:error.code,message:error.message,requestId:req.requestId}});throw error}
});
}
