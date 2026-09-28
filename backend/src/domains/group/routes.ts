import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { mediaFile } from '../message/media.js';
export function registerGroupRoutes(app:Application,pool:Pool,broadcast:(type:string,payload:any)=>void,auth:RequestHandler,write:RequestHandler){
  const gatewayUrl=process.env.GATEWAY_URL||'http://localhost:28081';
  async function gatewayCall(path:string,method='GET',body?:any,traceId?:string){const response=await fetch(`${gatewayUrl}${path}`,{method,headers:{'content-type':'application/json',...(traceId?{'x-trace-id':traceId}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await response.json().catch(()=>({}));return {response,data};}
  type StoredMember={accountId:string;platformUserId:string;role:string;displayName?:string|null;status?:string|null};
  type GatewayMember={platformUserId:string;userId?:string|null;displayName?:string|null;role?:string|null};
  async function groupView(g:any){
    const stored=(await pool.query(`SELECT m.account_id AS "accountId",m.platform_user_id AS "platformUserId",m.role,a.display_name AS "displayName",a.status
      FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 ORDER BY m.account_id`,[g.id])).rows as StoredMember[];
    const storedByPlatform=new Map(stored.map(member=>[member.platformUserId,member]));
    let gatewayMembers:any[];
    let gatewayMembersSynced=true;
    try{
      const remote=await gatewayCall(`/groups/${encodeURIComponent(g.gateway_group_id)}/members`);
      if(!remote.response.ok||!Array.isArray(remote.data))throw new Error(`Gateway members returned ${remote.response.status}`);
      gatewayMembers=(remote.data as GatewayMember[]).filter(member=>typeof member?.platformUserId==='string'&&member.platformUserId).map(member=>{
        const managed=storedByPlatform.get(member.platformUserId);
        return {
          id:managed?.accountId||member.userId||member.platformUserId,
          accountId:managed?.accountId||null,
          platformUserId:member.platformUserId,
          displayName:member.displayName||managed?.displayName||managed?.accountId||member.userId||member.platformUserId,
          role:['creator','admin','member'].includes(String(member.role))?member.role:(managed?.role||'member'),
          managed:Boolean(managed),
          status:managed?.status||null,
        };
      });
    }catch(error){
      gatewayMembersSynced=false;
      gatewayMembers=stored.map(member=>({id:member.accountId,accountId:member.accountId,platformUserId:member.platformUserId,displayName:member.displayName||member.accountId,role:member.role,managed:true,status:member.status||null}));
      console.error(JSON.stringify({event:'gateway_members_sync_failed',groupId:g.id,gatewayGroupId:g.gateway_group_id,error:String(error)}));
    }
    return {id:g.id,gatewayGroupId:g.gateway_group_id,status:g.status,creatorAccountId:g.creator_account_id,agentEnabled:g.agent_enabled,autoKickEnabled:g.auto_kick_enabled,members:stored.map(({displayName,status,...member})=>member),gatewayMembers,gatewayMembersSynced,activeSequenceRunId:(await pool.query("SELECT id FROM sequence_runs WHERE group_id=$1 AND status='running' LIMIT 1",[g.id])).rows[0]?.id||null,activeAgentRunId:(await pool.query("SELECT id FROM agent_runs WHERE group_id=$1 AND status='running' LIMIT 1",[g.id])).rows[0]?.id||null};
  }
app.get('/api/media/:id',auth,async(req,res)=>{const item=await mediaFile(pool,String(req.params.id));if(!item)return res.status(404).json({error:{code:'MEDIA_NOT_FOUND',message:'媒体文件不存在',requestId:req.requestId}});res.type(item.contentType);if(item.fileName)res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`);res.sendFile(item.path,error=>{if(error&&!res.headersSent)res.status(404).json({error:{code:'MEDIA_NOT_FOUND',message:'媒体文件不存在',requestId:req.requestId}})});});
app.get('/api/groups',auth,async(req,res)=>{const rows=(await pool.query('SELECT * FROM groups ORDER BY id DESC')).rows;res.json(await Promise.all(rows.map(groupView)))});
app.post('/api/groups',auth,write,async(req,res)=>{
  const {creatorAccountId,memberAccountIds}=req.body||{};
  if(typeof creatorAccountId!=='string'||!creatorAccountId.trim()||!Array.isArray(memberAccountIds)||memberAccountIds.length<1||memberAccountIds.some((id:unknown)=>typeof id!=='string'||!(id as string).trim())||new Set([creatorAccountId,...memberAccountIds]).size!==memberAccountIds.length+1)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'群主与成员账号必须有效且不重复',requestId:req.requestId}});
  const ids=[creatorAccountId,...memberAccountIds];
  const accounts=await pool.query('SELECT id,status FROM accounts WHERE id=ANY($1)',[ids]);
  if(accounts.rows.length!==ids.length||accounts.rows.some(row=>row.status!=='online'))return res.status(422).json({error:{code:'ACCOUNT_NOT_ONLINE',message:'全部账号必须在线',requestId:req.requestId}});
  const job=await pool.query("INSERT INTO jobs(status,kind,payload,trace_id) VALUES('running','create',$1,$2) RETURNING id",[JSON.stringify({creatorAccountId,memberAccountIds}),req.traceId]);
  return res.status(202).json({jobId:job.rows[0].id});
});
app.get('/api/jobs/:id',auth,async(req,res)=>{const q=await pool.query('select * from jobs where id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:{code:'NOT_FOUND',message:'资源不存在',requestId:req.requestId}});res.json(q.rows[0])});
app.get('/api/groups/:id',auth,async(req,res)=>{const q=await pool.query('select * from groups where id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:{code:'NOT_FOUND',message:'资源不存在',requestId:req.requestId}});res.json(await groupView(q.rows[0]))});
app.patch('/api/groups/:id',auth,write,async(req,res)=>{const fields=[];const vals:boolean[]=[];for(const k of ['agentEnabled','autoKickEnabled'])if(req.body?.[k]!==undefined){if(typeof req.body[k]!=='boolean')return res.status(400).json({error:{code:'VALIDATION_ERROR',message:`${k} 必须是布尔值`,requestId:req.requestId}});fields.push(`${k==='agentEnabled'?'agent_enabled':'auto_kick_enabled'}=$${vals.length+1}`);vals.push(req.body[k])}if(!fields.length)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'至少提供一个可更新字段',requestId:req.requestId}});const updated=await pool.query(`update groups set ${fields.join(',')} where id=$${vals.length+1} returning id,status,agent_enabled,auto_kick_enabled`,[...vals,req.params.id]);if(!updated.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});broadcast('group_status_changed',{groupId:req.params.id,status:updated.rows[0].status,agentEnabled:updated.rows[0].agent_enabled,autoKickEnabled:updated.rows[0].auto_kick_enabled});return res.json({ok:true})});
app.post('/api/groups/:id/members/invite',auth,write,async(req,res)=>{const g=await pool.query('SELECT gateway_group_id,status FROM groups WHERE id=$1',[req.params.id]);if(!g.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});if(g.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});const r=await gatewayCall(`/groups/${g.rows[0].gateway_group_id}/invite`,'POST',req.body||{},req.traceId);if(!r.response.ok)return res.status(r.response.status).json({error:{code:r.data.code||'GATEWAY_ERROR',message:'网关邀请失败',requestId:req.requestId}});res.json(r.data)});
app.get('/api/groups/:id/join-requests',auth,async(req,res)=>{
  const exists=await pool.query('SELECT 1 FROM groups WHERE id=$1',[req.params.id]);
  if(!exists.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  const rows=await pool.query('SELECT id,group_id AS "groupId",account_id AS "accountId",status,error_code AS "errorCode",requested_at AS "requestedAt",decided_at AS "decidedAt" FROM group_join_requests WHERE group_id=$1 ORDER BY requested_at DESC LIMIT 100',[req.params.id]);
  return res.json(rows.rows);
});
app.post('/api/groups/:id/join-requests',auth,write,async(req,res)=>{
  const accountId=req.body?.accountId;
  if(typeof accountId!=='string'||!accountId)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'accountId 必填',requestId:req.requestId}});
  const group=await pool.query('SELECT status FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  if(group.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});
  const account=await pool.query('SELECT status FROM accounts WHERE id=$1',[accountId]);
  if(!account.rowCount)return res.status(404).json({error:{code:'ACCOUNT_NOT_FOUND',message:'账号不存在',requestId:req.requestId}});
  if(account.rows[0].status!=='online')return res.status(422).json({error:{code:'ACCOUNT_NOT_ONLINE',message:'账号必须在线才能申请入群',requestId:req.requestId}});
  const member=await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2',[req.params.id,accountId]);
  if(member.rowCount)return res.status(409).json({error:{code:'ALREADY_MEMBER',message:'账号已在群中',requestId:req.requestId}});
  try {
    const row=await pool.query('INSERT INTO group_join_requests(group_id,account_id,status,trace_id) VALUES($1,$2,$3,$4) RETURNING id,group_id AS "groupId",account_id AS "accountId",status,error_code AS "errorCode",requested_at AS "requestedAt",decided_at AS "decidedAt"',[req.params.id,accountId,'pending',req.traceId]);
    broadcast('group_join_request_changed',{groupId:req.params.id,requestId:row.rows[0].id,accountId,status:'pending'});
    return res.status(201).json(row.rows[0]);
  } catch(error:any){
    if(error?.code==='23505')return res.status(409).json({error:{code:'JOIN_REQUEST_PENDING',message:'该账号已有待处理的入群申请',requestId:req.requestId}});
    throw error;
  }
});
app.post('/api/groups/:id/join-requests/:requestId/approve',auth,write,async(req,res)=>{
  const updated=await pool.query(
    `UPDATE group_join_requests r SET status='approved',decided_at=now()
     WHERE r.id=$1 AND r.group_id=$2 AND r.status='pending'
       AND EXISTS(SELECT 1 FROM groups g WHERE g.id=r.group_id AND g.status='active')
       AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=r.account_id AND a.status='online')
     RETURNING r.id,r.group_id AS "groupId",r.account_id AS "accountId",r.status,r.error_code AS "errorCode",r.requested_at AS "requestedAt",r.decided_at AS "decidedAt"`,
    [req.params.requestId,req.params.id],
  );
  if(!updated.rowCount)return res.status(409).json({error:{code:'JOIN_REQUEST_NOT_APPROVABLE',message:'申请不存在、已处理或群组/账号不可用',requestId:req.requestId}});
  const row=updated.rows[0];
  broadcast('group_join_request_changed',{groupId:row.groupId,requestId:row.id,accountId:row.accountId,status:'approved'});
  return res.json(row);
});
app.post('/api/groups/:id/join-requests/:requestId/reject',auth,write,async(req,res)=>{
  const updated=await pool.query(
    `UPDATE group_join_requests SET status='rejected',decided_at=now() WHERE id=$1 AND group_id=$2 AND status='pending'
     RETURNING id,group_id AS "groupId",account_id AS "accountId",status,error_code AS "errorCode",requested_at AS "requestedAt",decided_at AS "decidedAt"`,
    [req.params.requestId,req.params.id],
  );
  if(!updated.rowCount)return res.status(409).json({error:{code:'JOIN_REQUEST_NOT_PENDING',message:'申请不存在或已处理',requestId:req.requestId}});
  const row=updated.rows[0];
  broadcast('group_join_request_changed',{groupId:row.groupId,requestId:row.id,accountId:row.accountId,status:'rejected'});
  return res.json(row);
});
app.post('/api/groups/:id/members/join',auth,write,async(req,res)=>{
  const {accountId,inviteLink}=req.body||{};
  if(typeof accountId!=='string'||!accountId||typeof inviteLink!=='string'||!inviteLink)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'accountId 与 inviteLink 必填',requestId:req.requestId}});
  const g=await pool.query('SELECT gateway_group_id,status FROM groups WHERE id=$1',[req.params.id]);
  if(!g.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  if(g.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});
  const a=await pool.query('SELECT platform_user_id,status FROM accounts WHERE id=$1',[accountId]);
  if(!a.rowCount)return res.status(404).json({error:{code:'ACCOUNT_NOT_FOUND',message:'账号不存在',requestId:req.requestId}});
  if(a.rows[0].status!=='online')return res.status(422).json({error:{code:'ACCOUNT_NOT_ONLINE',message:'账号必须在线才能入群',requestId:req.requestId}});
  const r=await gatewayCall(`/groups/${g.rows[0].gateway_group_id}/join`,'POST',{accountId,inviteLink},req.traceId);
  if(!r.response.ok)return res.status(r.response.status).json({error:{code:r.data.code||'GATEWAY_ERROR',message:'网关入群失败',requestId:req.requestId}});
  return res.status(202).json({accepted:true});
});
app.post('/api/groups/:id/members/promote',auth,write,async(req,res)=>{const {byAccountId,accountId}=req.body||{};if(typeof byAccountId!=='string'||!byAccountId.trim()||typeof accountId!=='string'||!accountId.trim())return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'byAccountId 与 accountId 必填',requestId:req.requestId}});const g=await pool.query('SELECT gateway_group_id FROM groups WHERE id=$1',[req.params.id]);if(!g.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});const r=await gatewayCall(`/groups/${g.rows[0].gateway_group_id}/promote`,'POST',{byAccountId,accountId},req.traceId);if(!r.response.ok)return res.status(r.response.status).json({error:{code:r.data.code||'GATEWAY_ERROR',message:'网关晋升失败',requestId:req.requestId}});await pool.query("UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2",[req.params.id,accountId]);broadcast('group_members_changed',{groupId:req.params.id,accountId,action:'promoted'});res.json({})});
app.post('/api/groups/:id/members/kick',auth,write,async(req,res)=>{
  const {byAccountId,targetPlatformUserId}=req.body||{};
  if(typeof byAccountId!=='string'||!byAccountId.trim()||typeof targetPlatformUserId!=='string'||!targetPlatformUserId.trim())return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'byAccountId 与 targetPlatformUserId 必填',requestId:req.requestId}});
  const g=await pool.query('SELECT gateway_group_id FROM groups WHERE id=$1',[req.params.id]);
  if(!g.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  const gatewayGroupId=g.rows[0].gateway_group_id;
  const result=await gatewayCall(`/groups/${gatewayGroupId}/kick`,'POST',{byAccountId,targetPlatformUserId},req.traceId);
  if(!result.response.ok && result.response.status!==504)return res.status(result.response.status).json({error:{code:result.data.code||'GATEWAY_ERROR',message:'网关移除失败',requestId:req.requestId}});
  if(result.response.status===504){
    const deadline=Date.now()+2500;
    let removed=false;
    do{
      await new Promise(resolve=>setTimeout(resolve,250));
      try {
        const current=await gatewayCall(`/groups/${gatewayGroupId}/members`,'GET',undefined,req.traceId);
        if(!current.response.ok)continue;
        removed=Array.isArray(current.data)&&!current.data.some((member:any)=>member.platformUserId===targetPlatformUserId);
      } catch { continue; }
      if(removed)break;
    }while(Date.now()<deadline);
    if(!removed)return res.status(504).json({error:{code:'NETWORK_TIMEOUT',message:'移除结果仍未确认，请刷新成员列表',requestId:req.requestId}});
  }
  const deleted=await pool.query('DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2 RETURNING account_id',[req.params.id,targetPlatformUserId]);
  if(deleted.rowCount)broadcast('group_members_changed',{groupId:req.params.id,accountId:deleted.rows[0].account_id,action:'left'});
  return res.json({kicked:true});
});
app.post('/api/groups/:id/members/leave',auth,write,async(req,res)=>{const {accountId}=req.body||{};if(typeof accountId!=='string'||!accountId.trim())return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'accountId 必填',requestId:req.requestId}});const g=await pool.query('SELECT gateway_group_id FROM groups WHERE id=$1',[req.params.id]);if(!g.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});const r=await gatewayCall(`/groups/${g.rows[0].gateway_group_id}/leave`,'POST',{accountId},req.traceId);if(!r.response.ok)return res.status(r.response.status).json({error:{code:r.data.code||'GATEWAY_ERROR',message:'网关退群失败',requestId:req.requestId}});const deleted=await pool.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2 RETURNING account_id',[req.params.id,accountId]);if(deleted.rowCount)broadcast('group_members_changed',{groupId:req.params.id,accountId,action:'left'});res.json({})});
app.get('/api/groups/:id/messages',auth,async(req,res)=>{const group=await pool.query('SELECT 1 FROM groups WHERE id=$1',[req.params.id]);if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});const rawLimit=req.query.limit===undefined?'50':String(req.query.limit);const parsedLimit=Number(rawLimit);if(!Number.isInteger(parsedLimit)||parsedLimit<1)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'limit 必须是正整数',requestId:req.requestId}});const limit=Math.min(parsedLimit,100);let cursor:any=null;try{if(req.query.before){const raw=Buffer.from(String(req.query.before),'base64url').toString('utf8');cursor=JSON.parse(raw)}}catch{return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'无效的消息游标',requestId:req.requestId}})}const args:any[]=[req.params.id];let condition='';if(cursor){if(!cursor.sentAt||typeof cursor.sentAt!=='string'||!Number.isFinite(Date.parse(cursor.sentAt))||typeof cursor.id!=='string'||!/^[0-9a-f-]{36}$/i.test(cursor.id))return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'无效的消息游标',requestId:req.requestId}});args.push(cursor.sentAt,cursor.id);condition='AND (sent_at,id)<($2,$3)'}args.push(limit);const result=await pool.query(`SELECT id,msg_id AS "msgId",client_msg_id AS "clientMsgId",sender_platform_user_id AS "senderPlatformUserId",text,sent_at AS "sentAt",delivery_status AS "deliveryStatus",fail_code AS "failCode",is_own AS "isOwn",CASE WHEN local_file_path IS NULL THEN NULL ELSE '/api/media/'||id::text END AS "localFilePath",CASE WHEN media_file_name IS NULL AND media_url IS NULL AND media_status IS NULL THEN NULL ELSE jsonb_build_object('fileName',media_file_name,'contentType',media_content_type,'size',media_size,'status',media_status,'sourceUrl',media_url,'localUrl',CASE WHEN local_file_path IS NULL THEN NULL ELSE '/api/media/'||id::text END) END AS media FROM messages WHERE group_id=$1 ${condition} ORDER BY sent_at DESC,id DESC LIMIT $${args.length}`,args);const last=result.rows.at(-1);res.json({items:result.rows,nextCursor:result.rows.length===limit&&last?Buffer.from(JSON.stringify({sentAt:last.sentAt,id:last.id})).toString('base64url'):null})});
app.post('/api/groups/:id/send',auth,write,async(req,res)=>{const {accountId,text}=req.body||{};if(typeof text!=='string'||!text.trim()||typeof accountId!=='string'||!accountId)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'账号和文本必填',requestId:req.requestId}});const group=await pool.query('SELECT status FROM groups WHERE id=$1',[req.params.id]);if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});if(group.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可写',requestId:req.requestId}});const client=await pool.connect();let clientMsgId='';try{await client.query('BEGIN');const member=await client.query('SELECT m.platform_user_id,a.status FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND m.account_id=$2 FOR UPDATE OF a,m',[req.params.id,accountId]);if(!member.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:{code:'ACCOUNT_NOT_IN_GROUP',message:'账号不在群内',requestId:req.requestId}})}if(!['online','rate_limited'].includes(member.rows[0].status)){await client.query('ROLLBACK');return res.status(409).json({error:{code:'ACCOUNT_UNAVAILABLE',message:'账号不可用',requestId:req.requestId}})}clientMsgId=randomUUID();await client.query("INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id,trace_id) VALUES($1,$2,$3,$4,now(),'queued',true,$5,$6)",[req.params.id,clientMsgId,text,member.rows[0].platform_user_id,accountId,req.traceId]);await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}res.setHeader('x-trace-id',req.traceId);res.status(202).json({clientMsgId,traceId:req.traceId})});
app.post('/api/groups/:id/leave-all',auth,write,async(req,res)=>{
  const group=await pool.query('SELECT id FROM groups WHERE id=$1',[req.params.id]);
  if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  const job=await pool.query("INSERT INTO jobs(status,kind,group_id,trace_id) VALUES('running','leave_all',$1,$2) RETURNING id",[req.params.id,req.traceId]);
  return res.status(202).json({jobId:job.rows[0].id});
});
// The development gateway has a synthetic external-member endpoint. Keep it
// behind an explicit server flag and the normal admin middleware; the browser
// still talks only to Backend, and production never exposes this operation.
app.get('/api/agent-simulation',auth,(_req,res)=>res.json({enabled:process.env.ENABLE_GATEWAY_SIMULATION==='true'}));
app.post('/api/groups/:id/agent-simulation/messages',auth,write,async(req,res)=>{
  if(process.env.ENABLE_GATEWAY_SIMULATION!=='true')return res.status(404).json({error:{code:'NOT_FOUND',message:'当前环境未启用模拟外部成员',requestId:req.requestId}});
  const {senderPlatformUserId,text}=req.body||{};
  if(typeof senderPlatformUserId!=='string'||!/^external-[A-Za-z0-9_-]{1,60}$/.test(senderPlatformUserId)||typeof text!=='string'||!text.trim()||text.length>2000)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'外部成员 ID 须以 external- 开头，消息须为 1–2000 字',requestId:req.requestId}});
  const found=await pool.query('SELECT gateway_group_id,status FROM groups WHERE id=$1',[req.params.id]);
  if(!found.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});
  if(found.rows[0].status!=='active')return res.status(409).json({error:{code:'GROUP_UNREACHABLE',message:'群不可用',requestId:req.requestId}});
  const gatewayGroupId=encodeURIComponent(found.rows[0].gateway_group_id);
  const joined=await gatewayCall(`/groups/${gatewayGroupId}/external-member`,'POST',{platformUserId:senderPlatformUserId,action:'joined'},req.traceId);
  if(!joined.response.ok)return res.status(502).json({error:{code:'GATEWAY_ERROR',message:'模拟外部成员入群失败',requestId:req.requestId}});
  const sent=await gatewayCall(`/groups/${gatewayGroupId}/external-message`,'POST',{senderPlatformUserId,text:text.trim()},req.traceId);
  if(!sent.response.ok)return res.status(502).json({error:{code:'GATEWAY_ERROR',message:'模拟外部成员消息失败',requestId:req.requestId}});
  return res.status(202).json({msgId:sent.data.msgId,senderPlatformUserId,sentAt:sent.data.sentAt});
});
function agentRunView(run:any){return {id:run.id,groupId:run.group_id,status:run.status,endReason:run.end_reason,summary:run.summary,steps:run.steps,traceId:run.trace_id||null,createdAt:run.created_at}}app.get('/api/agent-runs/:id',auth,async(req,res)=>{const q=await pool.query('SELECT * FROM agent_runs WHERE id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:{code:'NOT_FOUND',message:'资源不存在',requestId:req.requestId}});res.json(agentRunView(q.rows[0]))});app.get('/api/groups/:id/agent-runs',auth,async(req,res)=>{const group=await pool.query('SELECT 1 FROM groups WHERE id=$1',[req.params.id]);if(!group.rowCount)return res.status(404).json({error:{code:'GROUP_NOT_FOUND',message:'群不存在',requestId:req.requestId}});res.json((await pool.query('SELECT * FROM agent_runs WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20',[req.params.id])).rows.map(agentRunView))});
}
