import type { Pool } from 'pg';
import type { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
export function createRealtime(pool:Pool,JWT_SECRET:string,wss:WebSocketServer){
type WsFrame={seq:number;type:string;payload:any};
const sockets=new Map<any,{replaying:boolean;buffer:WsFrame[]}>();
let publishChain=Promise.resolve();
function broadcast(type:string,payload:any){
  publishChain=publishChain.then(async()=>{
    const row=await pool.query('INSERT INTO websocket_events(type,payload) VALUES($1,$2) RETURNING seq',[type,payload]);
    const frame={seq:Number(row.rows[0].seq),type,payload};
    for(const [socket,state] of sockets){
      if(socket.readyState!==1)continue;
      if(state.replaying)state.buffer.push(frame);
      else socket.send(JSON.stringify(frame));
    }
  }).catch(error=>console.error(JSON.stringify({event:'ws_publish_failed',error:String(error)})));
}
wss.on('connection',socket=>{
  let authenticated=false;
  let authenticating=false;
  socket.on('message',async(data:any)=>{
    if(authenticated||authenticating)return;
    // Mark the handshake in progress before the first await. Otherwise two auth
    // frames in the same connection can race the session lookup and replay the
    // same sequence twice to one socket.
    authenticating=true;
    try{
      const message=JSON.parse(String(data));
      if(message.type!=='auth'||!Number.isSafeInteger(Number(message.sinceSeq||0))||Number(message.sinceSeq||0)<0)throw Error('AUTH_REQUIRED');
      const claims=jwt.verify(message.accessToken,JWT_SECRET) as any;
      const active=await pool.query('SELECT 1 FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[claims.sid,claims.sub]);
      if(!active.rowCount)throw Error('session revoked');
      authenticated=true;
      const state={replaying:true,buffer:[] as WsFrame[]};
      sockets.set(socket,state);
      socket.send(JSON.stringify({type:'auth',success:true}));
      let cursor=Number(message.sinceSeq||0);
      for(;;){
        const events=await pool.query('SELECT seq,type,payload FROM websocket_events WHERE seq>$1 ORDER BY seq LIMIT 1000',[cursor]);
        for(const row of events.rows){const frame={seq:Number(row.seq),type:row.type,payload:row.payload};socket.send(JSON.stringify(frame));cursor=frame.seq}
        if((events.rowCount||0)<1000)break;
      }
      for(const frame of state.buffer.sort((a,b)=>a.seq-b.seq))if(frame.seq>cursor){socket.send(JSON.stringify(frame));cursor=frame.seq}
      state.buffer=[];
      state.replaying=false;
    }catch{
      if(socket.readyState===1)socket.send(JSON.stringify({type:'auth',success:false}));
      socket.close();
    }
  });
  socket.on('close',()=>sockets.delete(socket));
});
return broadcast;
}
