import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { client, clearSession, currentSession, errorText, setSession } from './api/client';
import type { Account, AgentRun, GatewayGroupMember, Group, GroupJoinRequest } from './generated';
import { useEvents } from './hooks/useEvents';
import { GroupCreation } from './components/GroupCreation';
import { SequencePanel } from './components/SequencePanel';
import { MessageServiceLive } from './components/MessageServiceLive';
import { Activity, Bot, Check, ChevronRight, Layers3, LogOut, MessageSquareText, RefreshCw, Shield, Users, Zap } from 'lucide-react';
import './style.css';

type SequenceRoute = { nav: string; action?: 'create' | 'edit' | 'run'; id?: string };
const displayGroupId = (group: Pick<Group, 'id' | 'gatewayGroupId'>) => (group.gatewayGroupId || group.id).replace(/^gw-/, '').slice(0, 8);
function parseRoute(): SequenceRoute {
  const path = window.location.hash.slice(1) || 'overview';
  const [nav, action, id] = path.split('/');
  return { nav, action: nav === 'sequence' && (action === 'create' || action === 'edit' || action === 'run') ? action : undefined, id: nav === 'sequence' ? id : undefined };
}

function Login({ onReady }: { onReady: () => void }) {
  const [username, setUsername] = useState('admin'); const [password, setPassword] = useState('admin'); const [error, setError] = useState('');
  return <div className="login-page"><aside className="login-aside"><div className="brand-lockup"><div className="brand-mark"><Shield size={19}/></div><div><div className="brand">SENTINEL</div><div className="brand-caption">Messaging operations</div></div></div><div className="login-pitch"><div className="eyebrow">SECURE MESSAGING OPERATIONS</div><h1>把多账号消息运营，变得清晰可靠。</h1><p>统一管理账号、群组与自动化消息流程，让每一次沟通都井然有序。</p><div className="login-feature"><Check size={16}/>实时状态监控 · 可审计自动化</div></div><footer>Sentinel Messaging Platform · Secure workspace</footer></aside><div className="login-form-side"><form className="login" onSubmit={async e => { e.preventDefault(); try { const response = await client.login({ loginRequest: { username, password } }); setSession(response.accessToken); onReady(); } catch (e) { setError(await errorText(e)); } }}><div className="eyebrow">欢迎回来</div><h1>登录控制台</h1><p className="login-intro">输入你的工作区账号以继续。</p><label>用户名<Input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label><label>密码<Input autoComplete="current-password" type="password" value={password} onChange={e => setPassword(e.target.value)} /></label>{error && <p className="error">{error}</p>}<Button className="login-submit" type="submit">登录工作区 <ChevronRight size={16}/></Button><small className="login-hint">演示账号：admin/admin · viewer/viewer</small></form></div></div>;
}
function Accounts({ canWrite, onChanged, onOpenGroup }: { canWrite: boolean; onChanged: () => void; onOpenGroup: (id: string) => void }) {
  const [items, setItems] = useState<Account[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [joinRequests, setJoinRequests] = useState<GroupJoinRequest[]>([]);
  const [targetGroups, setTargetGroups] = useState<Record<string, string>>({});
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    try {
      const [accountList, groupList] = await Promise.all([client.listAccounts(), client.listGroups()]);
      setItems(accountList);
      setGroups(groupList);
      const results = await Promise.allSettled(groupList.map(group => client.listGroupJoinRequests({ id: group.id })));
      setJoinRequests(results.flatMap(result => result.status === 'fulfilled' ? result.value : []));
      setError('');
    } catch (value) { setError(await errorText(value)); }
  };
  useEffect(() => { void load(); }, []);
  useEvents(type => { if (['account_created', 'account_updated', 'account_deleted', 'account_status_changed', 'account_terminal', 'group_members_changed', 'group_join_request_changed', 'group_status_changed'].includes(type)) void load(); });
  async function act(id: string, action: 'connect' | 'disconnected' | 'idle', current: string) {
    try {
      if (action === 'connect') await client.connectAccount({ id });
      else await client.transitionAccount({ id, transitionRequest: { to: action, expectedFrom: current } });
      await load(); onChanged();
    } catch (value) { setError(await errorText(value)); }
  }
  async function applyToGroup(accountId: string) {
    const id = targetGroups[accountId];
    if (!id) return;
    try {
      await client.createGroupJoinRequest({ id, createJoinRequest: { accountId } });
      setNotice(`${accountId} 的申请已提交，请到群组审批列表处理`);
      await load();
    } catch (value) { setError(await errorText(value)); }
  }
  async function createAccount() {
    if (!newId.trim() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await client.createAccount({ createAccountRequest: { id: newId.trim(), displayName: newName.trim() || undefined } });
      setNotice(`账号 ${newId.trim()} 已创建`); setNewId(''); setNewName(''); await load(); onChanged();
    } catch (value) { setError(await errorText(value)); }
    finally { setBusy(false); }
  }
  async function updateAccount(id: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await client.updateAccount({ id, updateAccountRequest: { displayName: editingName.trim() } }); setEditingId(null); setNotice(`账号 ${id} 已更新`); await load(); onChanged(); }
    catch (value) { setError(await errorText(value)); }
    finally { setBusy(false); }
  }
  async function deleteAccount(id: string) {
    if (busy || !window.confirm(`删除账号 ${id}？历史消息会保留，已删除的账号 ID 不能重新使用。`)) return;
    setBusy(true); setError(''); setNotice('');
    try { await client.deleteAccount({ id }); setNotice(`账号 ${id} 已删除`); await load(); onChanged(); }
    catch (value) { setError(await errorText(value)); }
    finally { setBusy(false); }
  }
  return <section id="accounts"><div className="section-title"><div><h2>账号</h2><p className="section-kicker">管理账号资料、连接状态、群组成员身份与入群申请</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw size={15}/>刷新</Button></div>{canWrite && <div className="account-create-panel"><div><strong>添加账号</strong><small>账号 ID 创建后不可修改，创建时同步注册到 Gateway。</small></div><Input aria-label="新账号 ID" value={newId} onChange={event => setNewId(event.target.value)} placeholder="账号 ID，例如 acc-6" maxLength={64}/><Input aria-label="新账号名称" value={newName} onChange={event => setNewName(event.target.value)} placeholder="显示名称（选填）" maxLength={80}/><Button disabled={busy || !newId.trim()} onClick={() => void createAccount()}>添加账号</Button></div>}{error && <p className="error">{error}</p>}{notice && <p className="group-join-result" role="status">{notice}</p>}{items.length === 0 && !error ? <div className="empty-state"><Users size={22}/><strong>还没有账号</strong><small>添加账号后即可连接并创建群组。</small></div> : <div className="grid">{items.map(item => { const memberships = groups.filter(group => group.members?.some(member => member.accountId === item.id)); const applications = joinRequests.filter(request => request.accountId === item.id && ['pending','approved'].includes(request.status)); const available = groups.filter(group => group.status === 'active' && !memberships.some(memberGroup => memberGroup.id === group.id) && !applications.some(request => request.groupId === group.id)); return <article key={item.id}><div className="row"><div className="account-identity"><b>{item.displayName || item.id}</b>{item.displayName && <small>{item.id}</small>}</div><span className={`status ${item.status}`}>{item.status.replace('_',' ')}</span></div><small>{item.platformUserId || '尚未连接到平台'}</small>{canWrite && <div className="actions">{['idle', 'disconnected'].includes(item.status) && <Button size="sm" onClick={() => void act(item.id, 'connect', item.status)}>连接账号</Button>}{['online', 'rate_limited'].includes(item.status) && <Button variant="outline" size="sm" onClick={() => void act(item.id, 'disconnected', item.status)}>标记离线</Button>}{item.status === 'disconnected' && <Button variant="ghost" size="sm" onClick={() => void act(item.id, 'idle', item.status)}>释放账号</Button>}<Button variant="outline" size="sm" onClick={() => { setEditingId(item.id); setEditingName(item.displayName || ''); }}>编辑</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void deleteAccount(item.id)}>删除</Button></div>}{editingId === item.id && canWrite && <div className="account-edit-panel"><Input aria-label={`${item.id} 显示名称`} value={editingName} onChange={event => setEditingName(event.target.value)} placeholder="显示名称" maxLength={80}/><Button size="sm" disabled={busy} onClick={() => void updateAccount(item.id)}>保存</Button><Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button></div>}<div className="account-group-section"><strong>所属群组</strong>{memberships.length === 0 ? <small>尚未加入群组</small> : memberships.map(group => <button type="button" key={group.id} onClick={() => onOpenGroup(group.id)}>群组 {displayGroupId(group)} · {group.members?.find(member => member.accountId === item.id)?.role} <ChevronRight size={13}/></button>)}{applications.map(request => <button type="button" key={request.id} onClick={() => onOpenGroup(request.groupId)}>申请 {request.groupId.slice(0, 8)} · {request.status === 'pending' ? '待审批' : '入群中'} <ChevronRight size={13}/></button>)}{canWrite && item.status === 'online' && available.length > 0 && <div className="account-apply"><select aria-label={`${item.id} 申请群组`} value={targetGroups[item.id] || ''} onChange={event => setTargetGroups(old => ({ ...old, [item.id]: event.target.value }))}><option value="">选择申请群组</option>{available.map(group => <option key={group.id} value={group.id}>群组 {displayGroupId(group)}</option>)}</select><Button size="sm" disabled={!targetGroups[item.id]} onClick={() => void applyToGroup(item.id)}>提交入群申请</Button></div>}</div></article>; })}</div>}</section>;
}
function AgentDetails({ run, openByDefault = false }: { run: AgentRun; openByDefault?: boolean }) { const [detail, setDetail] = useState<AgentRun | null>(null); const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState(''); const load = async () => { if (loading) return; setLoading(true); setLoadError(''); try { setDetail(await client.getAgentRun({ id: run.id })); } catch (value) { setLoadError(await errorText(value)); } finally { setLoading(false); } }; useEffect(() => { setDetail(null); if (openByDefault) void load(); }, [run.id]); useEvents((type, payload) => { if (detail && type === 'agent_run' && (payload as { runId?: string } | null)?.runId === run.id) void load(); }); return <div className={`run ${run.status === 'blocked' ? 'blocked' : ''}`}><Button className="run-title" aria-expanded={Boolean(detail)} onClick={() => { if (detail) setDetail(null); else void load(); }}>{run.id.slice(0, 8)} · {run.status} · {run.endReason || 'running'} · {detail ? '收起详情' : '查看详情'}</Button>{loadError && <small className="error">{loadError}</small>}{loading && <small className="muted">正在加载运行详情…</small>}{detail && <div className="steps" data-testid={`agent-run-detail-${run.id}`}><small className="trace-id">trace_id：{detail.traceId || '未记录'}</small>{detail.summary && <p className="run-summary"><b>运行总结：</b>{detail.summary}</p>}{!detail.steps?.length && <p>正在等待 Agent 返回第一步…</p>}{detail.steps?.map((step, index) => <article key={index}><b>步骤 {index + 1}</b><span>kind：{step.kind}</span><span>工具名：{step.name || '—'}</span><pre>入参：{step.input ? JSON.stringify(step.input, null, 2) : '—'}</pre><p><b>结果摘要：</b>{step.resultSummary || '—'}</p><span>审计结论：{step.auditVerdict || '未执行'}</span><span className={step.errorCode ? 'error' : ''}>错误码：{step.errorCode || '无'}</span>{step.kind === 'protocol_error' && <details><summary>查看原始响应体</summary><pre>{step.rawResponse || '（空响应）'}</pre></details>}</article>)}</div>}</div>; }
function GroupsPage({ groups, canWrite, focusGroupId, onRefresh, onOpen }: { groups: Group[]; canWrite: boolean; focusGroupId: string | null; onRefresh: () => void; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all'); const [expanded, setExpanded] = useState<string | null>(null); const [accounts, setAccounts] = useState<Account[]>([]); const [agentRuns, setAgentRuns] = useState<Record<string, AgentRun[]>>({}); const [notice, setNotice] = useState(''); const [joinAccount, setJoinAccount] = useState(''); const [joinNotice, setJoinNotice] = useState<Record<string, string>>({}); const [joinRequests, setJoinRequests] = useState<Record<string, GroupJoinRequest[]>>({}); const [requestBusy, setRequestBusy] = useState(false); const [inviteInfo, setInviteInfo] = useState<{ groupId: string; link: string; readyAfterMs: number }>({ groupId: '', link: '', readyAfterMs: 0 });
  useEffect(() => { void client.listAccounts().then(setAccounts).catch(() => {}); }, [groups.length]);
  useEffect(() => { if (focusGroupId) setExpanded(focusGroupId); }, [focusGroupId]);
  const loadAgentRuns = async (id: string) => { try { const list = await client.listAgentRuns({ id }); setAgentRuns(old => ({ ...old, [id]: list })); } catch (error) { setNotice(await errorText(error)); } };
  useEvents(() => { void client.listAccounts().then(setAccounts).catch(() => {}); void onRefresh(); if (expanded) void loadAgentRuns(expanded); });
  const filtered = groups.filter(group => {
    const needle=query.toLowerCase();
    return (status === 'all' || group.status === status) && (!needle || group.id.toLowerCase().includes(needle) || group.gatewayGroupId?.toLowerCase().includes(needle) || group.gatewayMembers?.some(member => [member.id,member.accountId,member.platformUserId,member.displayName].some(value=>value?.toLowerCase().includes(needle))));
  });
  const active = groups.filter(group => group.status === 'active').length; const unreachable = groups.filter(group => group.status !== 'active').length; const agentEnabled = groups.filter(group => group.agentEnabled).length;
  const updateGroup = async (id: string, patch: { agentEnabled?: boolean; autoKickEnabled?: boolean }) => { try { await client.patchGroup({ id, groupPatch: patch }); await onRefresh(); } catch (e) { setNotice(await errorText(e)); } };
  const invite = async (id: string) => { try { const result = await client.inviteGroupMember({ id }); const link = result.inviteLink || ''; setInviteInfo({ groupId: id, link, readyAfterMs: Number(result.readyAfterMs || 0) }); setNotice(link ? `邀请链接已生成${result.readyAfterMs ? `，${result.readyAfterMs}ms 后可用` : ''}` : '邀请链接已生成'); } catch (e) { setNotice(await errorText(e)); } };
  const memberAction = async (group: Group, member: GatewayGroupMember, action: 'promote' | 'kick' | 'leave') => {
    if (!canWrite) return;
    if ((action === 'promote' || action === 'leave') && (!member.managed || !member.accountId)) { setNotice('该成员不是平台托管账号，不能由平台执行此操作'); return; }
    if ((action === 'promote' || action === 'kick') && (!group.creatorAccountId || !member.platformUserId)) { setNotice('群主或目标用户 ID 缺失，无法操作'); return; }
    if ((action === 'kick' || action === 'leave') && !window.confirm(`确认让 ${member.displayName} 离开群组 ${displayGroupId(group)}？`)) return;
    try {
      if (action === 'promote') await client.promoteGroupMember({ id: group.id, promoteRequest: { byAccountId: group.creatorAccountId!, accountId: member.accountId! } });
      else if (action === 'kick') await client.kickGroupMember({ id: group.id, kickGroupMemberRequest: { byAccountId: group.creatorAccountId!, targetPlatformUserId: member.platformUserId! } });
      else await client.leaveGroupMember({ id: group.id, leaveGroupMemberRequest: { accountId: member.accountId! } });
      setNotice(`${member.displayName} ${action === 'promote' ? '已提升为管理员' : action === 'kick' ? '已移出群组' : '已退出群组'}`);
      await onRefresh();
    } catch (error) { setNotice(await errorText(error)); await onRefresh(); }
  };
  const copyInvite = async () => { if (!inviteInfo.link) return; try { await navigator.clipboard.writeText(inviteInfo.link); setNotice('邀请链接已复制'); } catch { setNotice(`邀请链接：${inviteInfo.link}`); } };
  const loadJoinRequests = async (id: string) => {
    try {
      const list = await client.listGroupJoinRequests({ id });
      setJoinRequests(old => ({ ...old, [id]: list }));
    } catch (error) { const message = await errorText(error); setJoinNotice(old => ({ ...old, [id]: message })); }
  };
  useEffect(() => {
    if (!expanded) return;
    void loadJoinRequests(expanded);
    void loadAgentRuns(expanded);
    const timer = window.setInterval(() => { void loadJoinRequests(expanded); }, 1500);
    return () => window.clearInterval(timer);
  }, [expanded]);
  const submitJoinRequest = async (id: string) => {
    const accountId = joinAccount;
    if (!accountId || requestBusy) return;
    setRequestBusy(true);
    try {
      await client.createGroupJoinRequest({ id, createJoinRequest: { accountId } });
      setJoinAccount('');
      setJoinNotice(old => ({ ...old, [id]: `${accountId} 的入群申请已提交，等待管理员审批` }));
      await loadJoinRequests(id);
    } catch (error) {
      const message = await errorText(error);
      setJoinNotice(old => ({ ...old, [id]: message }));
    } finally { setRequestBusy(false); }
  };
  const decideJoinRequest = async (id: string, requestId: string, decision: 'approve' | 'reject') => {
    if (requestBusy) return;
    setRequestBusy(true);
    try {
      if (decision === 'approve') await client.approveGroupJoinRequest({ id, requestId });
      else await client.rejectGroupJoinRequest({ id, requestId });
      setJoinNotice(old => ({ ...old, [id]: decision === 'approve' ? '已同意申请，后台正在向网关提交入群' : '已拒绝申请，未调用网关入群' }));
      await loadJoinRequests(id);
      await onRefresh();
    } catch (error) {
      const message = await errorText(error);
      setJoinNotice(old => ({ ...old, [id]: message }));
    } finally { setRequestBusy(false); }
  };
  return <section className="groups-workspace"><div className="groups-toolbar-top"><div><div className="eyebrow">GROUP OPERATIONS</div><h2>群组工作台</h2><p>集中查看群组健康状态、成员规模和自动化能力。</p></div><Button onClick={onRefresh}><RefreshCw size={15}/>刷新数据</Button></div>{notice && <div className="group-notice" role="status"><span>{notice}{inviteInfo.link && <><code>{inviteInfo.link}</code><small>链接只代表入群申请，最终是否入群以成员事件为准。</small></>}</span><div>{inviteInfo.link && <Button variant="outline" size="sm" onClick={() => void copyInvite()}>复制链接</Button>}<button type="button" onClick={() => { setNotice(''); setInviteInfo({ groupId: '', link: '', readyAfterMs: 0 }); }}>×</button></div></div>}<div className="group-metrics"><article><span className="metric-icon purple"><Layers3 size={17}/></span><div><strong>{groups.length}</strong><small>全部群组</small></div></article><article><span className="metric-icon green"><span className="metric-dot"/></span><div><strong>{active}</strong><small>运行中</small></div></article><article><span className="metric-icon amber"><Bot size={17}/></span><div><strong>{agentEnabled}</strong><small>Agent 已启用</small></div></article><article><span className="metric-icon red"><span className="metric-dot"/></span><div><strong>{unreachable}</strong><small>需要关注</small></div></article></div><div className="groups-controls"><div className="group-search"><span>⌕</span><Input aria-label="搜索群组" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索群组或成员…"/></div><div className="group-filters"><button className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>全部 <b>{groups.length}</b></button><button className={status === 'active' ? 'active' : ''} onClick={() => setStatus('active')}>运行中 <b>{active}</b></button><button className={status === 'unreachable' ? 'active' : ''} onClick={() => setStatus('unreachable')}>不可用 <b>{unreachable}</b></button></div></div>{filtered.length === 0 ? <div className="empty-state groups-empty"><Layers3 size={26}/><strong>没有匹配的群组</strong><small>尝试调整搜索条件或创建一个新群组。</small></div> : <div className="group-cards">{filtered.map(group => { const members = group.gatewayMembers || []; const isExpanded = expanded === group.id; const runs = agentRuns[group.id] || []; return <article className={`group-card ${isExpanded ? 'expanded' : ''}`} key={group.id}><div className="group-card-head"><span className="group-avatar"><MessageSquareText size={19}/></span><div className="group-card-title"><h3>群组 {displayGroupId(group)}</h3><small>{group.gatewayGroupId}</small></div><span className={`health-badge ${group.status === 'active' ? 'healthy' : 'warning'}`}><i/> {group.status === 'active' ? '运行正常' : '不可用'}</span></div><div className="group-card-meta"><span><Users size={14}/>{group.gatewayMembersSynced === false ? "成员数待同步" : `${members.length} 位成员`}</span><span><Bot size={14}/>{group.agentEnabled ? 'Agent 已启用' : 'Agent 未启用'}</span><span>{group.autoKickEnabled ? '自动移除已开' : '自动移除已关'}</span></div><div className="group-members-preview">{members.slice(0, 5).map(member => <span className="member-avatar" title={`${member.displayName} · ${member.role}`} key={member.id}>{member.displayName.slice(0, 2)}</span>)}{members.length > 5 && <span className="member-avatar more">+{members.length - 5}</span>}<small>{members.map(member => member.displayName).join('、')}{group.gatewayMembersSynced === false ? ' · Gateway 成员暂时无法同步' : ''}</small></div>{isExpanded && <div className="group-card-details"><div className="group-detail-line"><span>群组状态</span><strong className={group.status === 'active' ? 'good' : 'bad'}>{group.status === 'active' ? '运行中' : '不可用'}</strong></div><div className="group-detail-line"><span>平台记录 ID</span><code>{group.id}</code></div><div className="group-detail-line"><span>群组 ID</span><code>{group.gatewayGroupId}</code></div><div className="group-detail-members"><span>Gateway 当前成员 {group.gatewayMembersSynced === false ? '（同步失败，以下为最近平台快照）' : ''}</span>{members.map(member => <div key={member.id}><span className="member-avatar">{member.displayName.slice(0, 2)}</span><b>{member.displayName}</b><small>{member.platformUserId} · {member.role}{member.managed ? ` · ${member.status || 'unknown'}` : ' · Gateway 用户'}</small>{canWrite && member.role !== 'creator' && <span className="group-member-actions">{member.managed && member.role === 'member' && <Button variant="outline" size="sm" onClick={() => void memberAction(group, member, 'promote')}>设为管理员</Button>}<Button variant="outline" size="sm" onClick={() => void memberAction(group, member, 'kick')}>移出</Button>{member.managed && <Button variant="outline" size="sm" onClick={() => void memberAction(group, member, 'leave')}>自行退群</Button>}</span>}</div>)}</div><div className="group-detail-actions"><Button variant="outline" size="sm" disabled={!canWrite || group.status !== 'active'} onClick={() => void invite(group.id)}>生成邀请链接</Button><Button variant="outline" size="sm" disabled={!canWrite} onClick={() => void updateGroup(group.id, { agentEnabled: !group.agentEnabled })}>{group.agentEnabled ? '关闭 Agent' : '开启 Agent'}</Button><Button variant="outline" size="sm" disabled={!canWrite} onClick={() => void updateGroup(group.id, { autoKickEnabled: !group.autoKickEnabled })}>{group.autoKickEnabled ? '关闭自动移除' : '开启自动移除'}</Button></div>{inviteInfo.groupId === group.id && inviteInfo.link && <div className="group-invite-result"><div><strong>邀请链接已生成</strong><small>{inviteInfo.readyAfterMs ? `${inviteInfo.readyAfterMs}ms 后可使用` : '现在可以使用'}</small></div><code>{inviteInfo.link}</code><Button variant="outline" size="sm" onClick={() => void copyInvite()}>复制链接</Button></div>}<div className="group-agent-panel"><div className="group-agent-panel-head"><div><strong><Bot size={15}/> Agent 运行</strong><small>{group.agentEnabled ? "已启用，外部成员消息会触发运行" : "未启用"}</small></div><Button variant="outline" size="sm" onClick={() => void loadAgentRuns(group.id)}>刷新运行</Button></div>{runs.length === 0 ? (!group.agentEnabled ? <div className="group-agent-empty">开启 Agent 后，这里会显示自动应答、审计和成员操作。</div> : <div className="group-agent-empty">暂无 Agent 运行记录</div>) : <div className="group-agent-runs">{runs.map((run, index) => <AgentDetails key={run.id} run={run} openByDefault={index === 0}/>)}</div>}</div><div className="group-join-panel"><strong>提交入群申请</strong><small>提交后会出现在下方审批列表；管理员同意后后台才调用网关。</small><div><select aria-label={`群组 ${displayGroupId(group)} 入群账号`} value={joinAccount} onChange={e => setJoinAccount(e.target.value)}><option value="">选择账号</option>{accounts.filter(account => account.status === 'online' && !group.members?.some(member => member.accountId === account.id) && !(joinRequests[group.id] || []).some(request => request.status === 'pending' && request.accountId === account.id)).map(account => <option value={account.id} key={account.id}>{account.id}</option>)}</select><Button size="sm" disabled={!canWrite || !joinAccount || requestBusy || group.status !== 'active'} onClick={() => void submitJoinRequest(group.id)}>提交入群申请</Button></div>{joinNotice[group.id] && <span className="group-join-result" role="status">{joinNotice[group.id]}</span>}<div className="group-approval-list"><strong>入群申请审批</strong>{(() => { const pendingRequests = (joinRequests[group.id] || []).filter(request => request.status === 'pending'); return pendingRequests.length === 0 ? <small className="group-approval-empty">暂无待审批申请</small> : pendingRequests.map(request => <div className="group-approval-row" key={request.id}><div><b>{request.accountId}</b><small>待审批</small></div><time>{new Date(request.requestedAt).toLocaleString()}</time>{canWrite && <span><Button size="sm" disabled={requestBusy} onClick={() => void decideJoinRequest(group.id, request.id, 'approve')}>同意</Button><Button size="sm" variant="outline" disabled={requestBusy} onClick={() => void decideJoinRequest(group.id, request.id, 'reject')}>拒绝</Button></span>}</div>); })()}</div></div></div>}<div className="group-card-footer"><small>群组 ID · {group.gatewayGroupId}</small><div><Button variant="outline" size="sm" onClick={() => setExpanded(isExpanded ? null : group.id)}>{isExpanded ? '收起详情' : '展开详情'}</Button><Button size="sm" onClick={() => onOpen(group.id)}>打开消息 <ChevronRight size={14}/></Button></div></div></article>; })}</div>}</section>;
}
function App() {
  const [, redraw] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [accountsVersion, setAccountsVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusGroupId, setFocusGroupId] = useState<string | null>(null);
  const [route, setRoute] = useState<SequenceRoute>(parseRoute);
  const activeNav = route.nav;
  const session = currentSession();
  const canWrite = session?.role === 'admin';
  useEffect(() => { if (session && activeNav !== 'message-service') client.listGroups().then(setGroups); }, [!!session, selected, activeNav]);
  useEffect(() => { const syncHash = () => setRoute(parseRoute()); window.addEventListener('hashchange', syncHash); return () => window.removeEventListener('hashchange', syncHash); }, []);
  if (!session) return <Login onReady={() => redraw(x => x + 1)} />;
  const userLabel = canWrite ? '管理员' : '只读成员';
  const navigate = (id: string) => { if (window.location.hash.slice(1) !== id) window.location.hash = id; else setRoute(parseRoute()); };
  const navLink = (id: string, icon: React.ReactNode, label: string) => <a className={activeNav === id ? 'active' : ''} href={`#${id}`}>{icon}<span>{label}</span></a>;
  const pageTitle = activeNav === 'accounts' ? '账号管理' : activeNav === 'create-group' ? '创建群组' : activeNav === 'groups' ? '群组与消息' : activeNav === 'message-service' ? 'Gateway 消息服务' : activeNav === 'sequence' ? '自动化序列' : '运营概览';
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand-lockup"><div className="brand-mark"><Shield size={19}/></div><div><div className="brand">SENTINEL</div><div className="brand-caption">Messaging operations</div></div></div><div className="nav-label">工作区</div><nav className="side-nav">{navLink('overview', <Activity/>, '运营概览')}{navLink('accounts', <Users/>, '账号管理')}{navLink('create-group', <MessageSquareText/>, '创建群组')}{navLink('groups', <Layers3/>, '群组与消息')}{navLink('message-service', <MessageSquareText/>, 'Gateway 消息服务')}{navLink('sequence', <Zap/>, '自动化序列')}</nav><div className="sidebar-footer"><span className="service-indicator">服务运行正常</span></div></aside>
    <div className="workspace"><div className="topbar"><div className="breadcrumb"><span>工作区</span><ChevronRight size={14}/><strong>{pageTitle}</strong></div><nav className="top-nav" aria-label="主导航"><a className={activeNav === 'overview' ? 'active' : ''} href="#overview">Home</a><a className={activeNav === 'message-service' ? 'active' : ''} href="#message-service">Gateway 消息服务</a></nav><div className="profile"><div className="avatar">{canWrite ? 'A' : 'V'}</div><div className="profile-copy"><strong>{userLabel}</strong><small>{canWrite ? '完整访问权限' : '只读访问权限'}</small></div><Button variant="ghost" size="icon-sm" aria-label="退出登录" title="退出登录" onClick={async () => { try { await client.logout(); } finally { clearSession(); redraw(x => x + 1); } }}><LogOut size={16}/></Button></div></div>
      <main className={`page-content ${activeNav === 'message-service' ? 'message-page' : ''}`}>{activeNav !== 'message-service' && <div className="page-heading"><div><div className="eyebrow">MESSAGING OPERATIONS</div><h1>{pageTitle}</h1><p className="page-subtitle">统一管理账号、群组与自动化消息流程。</p></div><div className="header-actions"><span className="service-indicator">系统运行中</span></div></div>}
        {activeNav === 'overview' && <section className="home-page"><div className="home-hero"><div><div className="eyebrow">WORKSPACE HOME</div><h2>消息运营工作台</h2><p>从这里进入账号、群组、消息服务和自动化流程。</p></div><Button onClick={() => navigate('message-service')}>打开消息服务 <ChevronRight size={16}/></Button></div><div className="home-stats"><article><strong>{groups.length}</strong><span>群组</span></article><article><strong>{groups.filter(g => g.status === 'active').length}</strong><span>活跃群组</span></article><article><strong>{groups.filter(g => g.agentEnabled).length}</strong><span>已启用 Agent</span></article></div><div className="home-shortcuts"><Button variant="outline" onClick={() => navigate('accounts')}><Users size={16}/>账号管理</Button>{canWrite && <Button variant="outline" onClick={() => navigate('create-group')}><MessageSquareText size={16}/>创建群组</Button>}<Button variant="outline" onClick={() => navigate('groups')}><Layers3 size={16}/>群组与消息</Button></div></section>}
        {activeNav === 'accounts' && <Accounts canWrite={canWrite} onChanged={() => setAccountsVersion(value => value + 1)} onOpenGroup={id => { setFocusGroupId(id); navigate('groups'); }} />}
        {activeNav === 'create-group' && canWrite && <section id="create-group"><GroupCreation refreshKey={accountsVersion} onCreated={async () => { setGroups(await client.listGroups()); navigate('groups'); }} /></section>}
        {activeNav === 'create-group' && !canWrite && <section className="empty-state"><strong>只读账号无法创建群组</strong></section>}
        {activeNav === 'groups' && <GroupsPage groups={groups} canWrite={canWrite} focusGroupId={focusGroupId} onRefresh={async () => setGroups(await client.listGroups())} onOpen={id => { setSelected(id); navigate('message-service'); }} />}
        {activeNav === 'message-service' && <MessageServiceLive preferredGatewayGroupId={groups.find(group => group.id === selected)?.gatewayGroupId} canWrite={canWrite} />}
        {activeNav === 'sequence' && <SequencePanel route={route} groupId={selected || ''} groups={groups} canWrite={canWrite} onNavigate={navigate} />}
      </main></div></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
