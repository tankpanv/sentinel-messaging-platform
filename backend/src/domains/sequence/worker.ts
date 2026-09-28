import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
export async function startSequenceWorker(pool:Pool,broadcast:(type:string,payload:any)=>void){
function scheduleNext(steps:any[],index:number,at:Date|string){
  if(steps[index+1])steps[index+1].scheduledAt=new Date(new Date(at).getTime()+Number(steps[index+1].delaySeconds||0)*1000).toISOString();
}
async function sequenceTick(){
  try{
    const runs=await pool.query("SELECT id FROM sequence_runs WHERE status='running' ORDER BY id");
    for(const item of runs.rows){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const query=await client.query("SELECT r.*,g.gateway_group_id,g.status AS group_status FROM sequence_runs r JOIN groups g ON g.id=r.group_id WHERE r.id=$1 FOR UPDATE OF r SKIP LOCKED",[item.id]);
        if(!query.rowCount){await client.query('COMMIT');continue}
        const run=query.rows[0];
        if(run.group_status!=='active'){await client.query("UPDATE sequence_runs SET status='stopped' WHERE id=$1",[run.id]);await client.query('COMMIT');broadcast('sequence_run',{runId:run.id,groupId:run.group_id,status:'stopped',currentStepIndex:run.current_step_index});continue}
        const steps=run.steps as any[];const index=run.current_step_index;
        if(index>=steps.length){await client.query("UPDATE sequence_runs SET status='finished' WHERE id=$1",[run.id]);await client.query('COMMIT');broadcast('sequence_run',{runId:run.id,groupId:run.group_id,status:'finished',currentStepIndex:index});continue}
        const step=steps[index];
        if(step.clientMsgId){
          const message=await client.query('SELECT delivery_status,sent_at,fail_code FROM messages WHERE client_msg_id=$1',[step.clientMsgId]);
          const delivery=message.rows[0]?.delivery_status;
          let progressEvent:any=null;
          if(delivery==='sent'){step.status='sent';step.sentAt=message.rows[0].sent_at;scheduleNext(steps,index,step.sentAt);await client.query('UPDATE sequence_runs SET steps=$2,current_step_index=$3 WHERE id=$1',[run.id,JSON.stringify(steps),index+1]);progressEvent={runId:run.id,groupId:run.group_id,status:'running',currentStepIndex:index+1};}
          else if(delivery==='accepted'&&step.status!=='accepted'){step.status='accepted';await client.query('UPDATE sequence_runs SET steps=$2 WHERE id=$1',[run.id,JSON.stringify(steps)]);progressEvent={runId:run.id,groupId:run.group_id,status:'running',currentStepIndex:index};}
          else if(delivery==='failed'||delivery==='cancelled'){
            step.status=delivery==='cancelled'?'skipped':'failed';
            step.sentAt=new Date().toISOString();
            if(delivery==='failed'){
              await client.query("UPDATE sequence_runs SET status='failed',steps=$2 WHERE id=$1",[run.id,JSON.stringify(steps)]);
              progressEvent={runId:run.id,groupId:run.group_id,status:'failed',currentStepIndex:index};
            } else {
              scheduleNext(steps,index,step.sentAt);
              await client.query('UPDATE sequence_runs SET steps=$2,current_step_index=$3 WHERE id=$1',[run.id,JSON.stringify(steps),index+1]);
              progressEvent={runId:run.id,groupId:run.group_id,status:'running',currentStepIndex:index+1};
            }
          }
          await client.query('COMMIT');if(progressEvent)broadcast('sequence_run',progressEvent);continue;
        }
        const previous=index===0?new Date(run.created_at).getTime():new Date(steps[index-1].sentAt).getTime();
        const dueAt=step.scheduledAt?new Date(step.scheduledAt).getTime():previous+Number(step.delaySeconds||0)*1000;
        if(Date.now()<dueAt){await client.query('COMMIT');continue}
        const role=step.accountRole==='admin'?"m.role IN ('creator','admin')":"m.role='member'";
        const explicitSender=typeof step.senderAccountId==='string'&&step.senderAccountId.length>0;
        const accounts=await client.query(`SELECT m.account_id,m.platform_user_id,a.status FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND ${explicitSender?'m.account_id=$2':role} AND a.status IN ('online','rate_limited') ORDER BY (a.status='online') DESC,(m.role='admin') DESC,m.account_id FOR UPDATE OF a,m`,explicitSender?[run.group_id,step.senderAccountId]:[run.group_id]);
        const account=accounts.rows[0];
        if(!account){
          step.status='skipped';step.sentAt=new Date().toISOString();scheduleNext(steps,index,step.sentAt);await client.query('UPDATE sequence_runs SET steps=$2,current_step_index=$3 WHERE id=$1',[run.id,JSON.stringify(steps),index+1]);await client.query('COMMIT');broadcast('sequence_run',{runId:run.id,groupId:run.group_id,status:'running',currentStepIndex:index+1});continue;
        }
        if(account.status==='rate_limited'){await client.query('COMMIT');continue}
        const clientMsgId=randomUUID();step.clientMsgId=clientMsgId;step.scheduledAt=new Date(dueAt).toISOString();step.accountId=account.account_id;
        await client.query("INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id,trace_id) VALUES($1,$2,$3,$4,now(),'queued',true,$5,$6)",[run.group_id,clientMsgId,step.text,account.platform_user_id,account.account_id,run.trace_id||null]);
        await client.query('UPDATE sequence_runs SET steps=$2 WHERE id=$1',[run.id,JSON.stringify(steps)]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');console.error(JSON.stringify({event:'sequence_tick_failed',runId:item.id,error:String(error)}));}
      finally{client.release()}
    }
  }catch(error){console.error(JSON.stringify({event:'sequence_scan_failed',error:String(error)}))}
  setTimeout(sequenceTick,500);
}
async function recoverSequenceSchedules(){
  const runs=await pool.query("SELECT id,created_at,current_step_index,steps FROM sequence_runs WHERE status='running'");
  for(const run of runs.rows){
    const steps=run.steps as any[];
    const index=run.current_step_index;
    const step=steps[index];
    if(!step||step.clientMsgId)continue;
    const previous=index===0?new Date(run.created_at).getTime():new Date(steps[index-1]?.sentAt||0).getTime();
    if(previous+Number(step.delaySeconds||0)*1000<=Date.now()){
      step.scheduledAt=new Date(Date.now()+Number(step.delaySeconds||0)*1000).toISOString();
      await pool.query('UPDATE sequence_runs SET steps=$2 WHERE id=$1',[run.id,JSON.stringify(steps)]);
    }
  }
}
await recoverSequenceSchedules();
void sequenceTick();
}
