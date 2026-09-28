import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const backend='http://127.0.0.1:28080', gateway='http://127.0.0.1:28081';
const login=await (await fetch(`${backend}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})})).json();
async function api(path){const r=await fetch(backend+path,{headers:{authorization:`Bearer ${login.accessToken}`}});assert(r.ok);return r.json();}
async function gw(path,body,method='POST'){const r=await fetch(gateway+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,`${path}: ${r.status}`);return r.json();}
const groups=await api('/api/groups');
const group=groups.find(g=>g.status==='active'&&g.gatewayMembersSynced);
assert(group,'active group with synchronized Gateway members required');
const user=await gw('/users',{displayName:'成员同步验证',platformUserId:`member-check-${Date.now()}`});
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:25173/#groups');
 await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码').fill('admin');await page.getByRole('button',{name:'登录工作区'}).click();
 const card=page.locator('.group-card').filter({has:page.locator('.group-card-title small',{hasText:group.gatewayGroupId})});
 await card.getByRole('button',{name:'展开详情'}).click();
 await gw(`/users/${user.id}/groups/${group.gatewayGroupId}/join`,{});
 await card.locator('.group-detail-members b',{hasText:user.displayName}).waitFor({timeout:10000});
 const detail=await api(`/api/groups/${group.id}`);
 const remote=await gw(`/groups/${group.gatewayGroupId}/members`,undefined,'GET');
 assert.deepEqual(detail.gatewayMembers.map(m=>m.platformUserId).sort(),remote.map(m=>m.platformUserId).sort());
 assert.equal(detail.gatewayMembers.find(m=>m.platformUserId===user.platformUserId).managed,false);
 assert.equal(await card.locator('.group-detail-members > div').count(),remote.length);
 await card.screenshot({path:'/tmp/group-members-consistency.png'});
 await gw(`/users/${user.id}/groups/${group.gatewayGroupId}/leave`,{});
 await card.locator('.group-detail-members b',{hasText:user.displayName}).waitFor({state:'detached',timeout:10000});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,environment:'repository simulated Gateway',backend,gateway,agent:'not invoked; no message sent',groupId:group.id,membersCompared:remote.length,checks:['full member set equality','browser member count','join and leave live updates','unmanaged user identity','no page errors'],screenshot:'/tmp/group-members-consistency.png'}));
}finally{await browser.close();await gw(`/users/${user.id}`,undefined,'DELETE');}
