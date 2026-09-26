import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto, { randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from './password.js';
export function registerAuthRoutes(app: Application,pool: Pool,JWT_SECRET: string): {auth:RequestHandler;write:RequestHandler}{
const hash=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
const issue=(payload:any)=>jwt.sign(payload,JWT_SECRET,{expiresIn:'15m'});
async function auth(req:any,res:any,next:any){const token=String(req.headers.authorization||'').replace(/^Bearer /,'');try{const claims=jwt.verify(token,JWT_SECRET) as any;if(!claims.sid)throw Error('missing session');const session=await pool.query('SELECT 1 FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[claims.sid,claims.sub]);if(!session.rowCount)throw Error('session revoked');req.user=claims;next()}catch{res.status(401).json({error:{code:'UNAUTHORIZED',message:'登录已过期',requestId:req.requestId}})}}function write(req:any,res:any,next:any){if(req.user?.role!=='admin')return res.status(403).json({error:{code:'FORBIDDEN',message:'只读用户无权操作',requestId:req.requestId}});next()}
const refreshCookie={httpOnly:true,sameSite:'lax' as const,secure:process.env.NODE_ENV==='production',maxAge:2592000000,path:'/api/auth'};
app.post('/api/auth/login',async(req,res)=>{
  const username=req.body?.username;
  const password=req.body?.password;
  if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'用户名和密码必填',requestId:req.requestId}});
  const query=await pool.query('SELECT * FROM users WHERE username=$1',[username]);
  const user=query.rows[0];
  const checked=user?await verifyPassword(password,user.password_hash):{valid:false,needsUpgrade:false};
  if(!checked.valid)return res.status(401).json({error:{code:'UNAUTHORIZED',message:'用户名或密码错误',requestId:req.requestId}});
  if(checked.needsUpgrade)await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.id,await hashPassword(password)]);
  const session=await pool.query('INSERT INTO auth_sessions(user_id) VALUES($1) RETURNING id',[user.id]);
  const refresh=randomUUID();
  await pool.query("INSERT INTO refresh_sessions(user_id,auth_session_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",[user.id,session.rows[0].id,hash(refresh)]);
  res.cookie('refresh_token',refresh,refreshCookie);
  return res.json({accessToken:issue({sub:user.id,sid:session.rows[0].id,username:user.username,role:user.role})});
});
app.post('/api/auth/refresh',async(req,res)=>{const token=req.cookies.refresh_token;if(!token)return res.status(401).json({error:{code:'UNAUTHORIZED',message:'无刷新令牌',requestId:req.requestId}});const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM refresh_sessions WHERE token_hash=$1 FOR UPDATE',[hash(token)]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(401).json({error:{code:'UNAUTHORIZED',message:'刷新令牌无效',requestId:req.requestId}})}const old=q.rows[0];if(old.used_at||old.revoked){await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[old.auth_session_id]);await client.query('COMMIT');res.clearCookie('refresh_token',{path:'/api/auth'});return res.status(401).json({error:{code:'UNAUTHORIZED',message:'旧令牌重放，会话已作废',requestId:req.requestId}})}const session=await client.query('SELECT revoked_at FROM auth_sessions WHERE id=$1',[old.auth_session_id]);if(!session.rowCount||session.rows[0].revoked_at||new Date(old.expires_at)<new Date()){await client.query('ROLLBACK');return res.status(401).json({error:{code:'UNAUTHORIZED',message:'会话失效',requestId:req.requestId}})}await client.query('UPDATE refresh_sessions SET used_at=now(),revoked=true WHERE id=$1',[old.id]);const fresh=randomUUID();await client.query("INSERT INTO refresh_sessions(user_id,auth_session_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",[old.user_id,old.auth_session_id,hash(fresh)]);const user=await client.query('SELECT * FROM users WHERE id=$1',[old.user_id]);await client.query('COMMIT');res.cookie('refresh_token',fresh,refreshCookie);return res.json({accessToken:issue({sub:user.rows[0].id,sid:old.auth_session_id,username:user.rows[0].username,role:user.rows[0].role})})}catch(error){await client.query('ROLLBACK');return res.status(503).json({error:{code:'DATABASE_ERROR',message:'刷新失败',requestId:req.requestId}})}finally{client.release()}});
app.post('/api/auth/logout',auth,async(req,res)=>{await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[req.user.sid]);res.clearCookie('refresh_token',{path:'/api/auth'});res.json({ok:true})});
return {auth,write};
}
