import { useEffect, useRef, useState } from 'react';
import { FileText, MessageSquareText, Paperclip, RefreshCw, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { gateway, gatewayEvents } from '../api/gateway';
import type { GatewayEvent, GatewayGroup, GatewayMessage, GatewayUser } from '../api/gateway';
import { GatewayUsers } from './GatewayUsers';

type Props = { preferredGatewayGroupId?: string | null; canWrite: boolean };
type PendingSend = { clientMsgId: string; accountId: string; text: string; mediaName?: string; status: 'submitting' | 'accepted' | 'unknown' | 'failed'; error?: string };
const short = (id: string) => id.replace(/^gw-/, '').slice(0, 8);
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function MessageServiceLive({ preferredGatewayGroupId, canWrite }: Props) {
  const [groups, setGroups] = useState<GatewayGroup[]>([]);
  const [users, setUsers] = useState<GatewayUser[]>([]);
  const [selected, setSelected] = useState<string | null>(preferredGatewayGroupId || null);
  const [group, setGroup] = useState<GatewayGroup | null>(null);
  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [eventLog, setEventLog] = useState<GatewayEvent[]>([]);
  const [senderPlatformUserId, setSenderPlatformUserId] = useState('');
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [inviteLink, setInviteLink] = useState('');
  const [joinAccountId, setJoinAccountId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [view, setView] = useState<'chat' | 'users'>('chat');
  const [sidePanel, setSidePanel] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const selectedRef = useRef(selected);
  const groupRequest = useRef(0);
  const senderByGroup = useRef(new Map<string, string>());
  const lastContiguous = useRef(0);
  const received = useRef(new Set<number>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  selectedRef.current = selected;


  async function loadOverview() {
    const [nextGroups, nextUsers] = await Promise.all([gateway.groups(), gateway.users()]);
    setGroups(nextGroups);
    setUsers(nextUsers);
    setCreatorId(old => nextUsers.some(user => user.id === old && user.capabilities.includes('create_group')) ? old : nextUsers.find(user => user.status === 'online' && user.capabilities.includes('create_group'))?.id || '');
    const preferred = preferredGatewayGroupId && nextGroups.some(item => item.id === preferredGatewayGroupId) ? preferredGatewayGroupId : null;
    if (!selectedRef.current) setSelected(preferred || nextGroups[0]?.id || null);
  }
  async function loadGroup(id: string) {
    const request = ++groupRequest.current;
    const [nextGroup, nextMessages, currentMembers] = await Promise.all([gateway.group(id), gateway.messages(id), gateway.members(id)]);
    if (selectedRef.current !== id || request !== groupRequest.current) return;
    setGroup({ ...nextGroup, members: currentMembers.map(member => member.platformUserId) });
    setMessages(nextMessages);
    // Preserve the chosen identity even if it leaves the group. Never silently send as another user.
    if (!senderByGroup.current.has(id)) senderByGroup.current.set(id, currentMembers[0]?.platformUserId || '');
    setSenderPlatformUserId(senderByGroup.current.get(id) || '');
    setOperatorId(old => users.some(user => user.id === old && user.capabilities.includes('operate_group') && currentMembers.some(member => member.platformUserId === user.platformUserId)) ? old : users.find(user => user.platformUserId === nextGroup.owner && user.capabilities.includes('operate_group'))?.id || '');
  }
  useEffect(() => {
    if (preferredGatewayGroupId) setSelected(preferredGatewayGroupId);
  }, [preferredGatewayGroupId]);
  useEffect(() => {
    let live = true;
    let close = () => {};
    void (async () => {
      try {
        const health = await gateway.health();
        if (!live) return;
        lastContiguous.current = health.eventId;
        await loadOverview();
        if (!live) return;
        const onEvent = (event: GatewayEvent) => {
          if (!Number.isSafeInteger(event.eventId) || event.eventId <= lastContiguous.current || received.current.has(event.eventId)) return;
          received.current.add(event.eventId);
          while (received.current.delete(lastContiguous.current + 1)) lastContiguous.current++;
          setStreamStatus('已连接');
          setEventLog(old => [event, ...old].slice(0, 30));
          if (event.type === 'message_sent' || event.type === 'message_failed') {
            setPending(old => old.map(item => item.clientMsgId === event.clientMsgId ? { ...item, status: (event.type === 'message_sent' ? 'accepted' : 'failed') as PendingSend['status'], error: event.type === 'message_failed' ? String(event.code) : undefined } : item).filter(item => item.clientMsgId !== event.clientMsgId || event.type !== 'message_sent'));
          }
          void loadOverview().catch(error => setNotice(String(error)));
          if (event.groupId === selectedRef.current) void loadGroup(event.groupId).catch(error => setNotice(String(error)));
        };
        close = gatewayEvents(lastContiguous.current, onEvent, () => setStreamStatus('重连中'), () => setStreamStatus('已连接'));
        setStreamStatus('已连接');
      } catch (error) { setStreamStatus('不可用'); setNotice(`Gateway 连接失败：${String(error)}`); }
    })();
    return () => { live = false; close(); };
  }, []);
  useEffect(() => { setGroup(null); setMessages([]); setInviteLink(''); setAttachment(null); setSidePanel(false); }, [selected]);
  useEffect(() => { if (selected) void loadGroup(selected).catch(error => setNotice(String(error))); }, [selected, users]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [messages, pending, selected]);

  async function run(label: string, action: () => Promise<unknown>, reloadGroup = true) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const result = await action();
      setNotice(`${label}成功${result && typeof result === 'object' ? ` · ${JSON.stringify(result)}` : ''}`);
      await loadOverview();
      if (reloadGroup && selectedRef.current) await loadGroup(selectedRef.current);
    } catch (error) { setNotice(`${label}失败 · ${String(error)}`); }
    finally { setBusy(false); }
  }
  async function send() {
    if (!selected || !senderPlatformUserId || (!text.trim() && !attachment) || busy) return;
    setBusy(true);
    const user = users.find(item => item.platformUserId === senderPlatformUserId);
    if (!user || !group?.members.includes(user.platformUserId)) {
      setNotice('所选用户已不在当前群，请重新选择发送用户');
      setBusy(false);
      return;
    }
    const clientMsgId = globalThis.crypto?.randomUUID?.() || `debug-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const value = text.trim();
    setText('');
    const selectedFile = attachment;
    setPending(old => [...old, { clientMsgId, accountId: user.displayName, text: value, mediaName: selectedFile?.name, status: 'submitting' }]);
    try {
      const uploaded = selectedFile ? await gateway.uploadMedia(selectedFile) : null;
      const result = await gateway.userSend(user.id, selected, value, clientMsgId, uploaded?.media.id);
      setAttachment(null);
      if (result.deliveryStatus === 'sent') {
        setPending(old => old.filter(item => item.clientMsgId !== clientMsgId));
        setNotice(`消息已发送${result.msgId ? ` · msgId ${result.msgId}` : ''}`);
        await loadGroup(selected);
        return;
      }
      setPending(old => old.map(item => item.clientMsgId === clientMsgId ? { ...item, status: 'accepted' } : item));
      setNotice(`Gateway 已受理 · clientMsgId ${clientMsgId}；最终结果以事件为准`);
    } catch (error) {
      const unknown = String(error).includes('NETWORK_TIMEOUT');
      setText(current => current || value);
      setPending(old => old.map(item => item.clientMsgId === clientMsgId ? { ...item, status: unknown ? 'unknown' : 'failed', error: String(error) } : item));
      setNotice(`Gateway 发送返回：${String(error)} · clientMsgId ${clientMsgId}`);
    } finally { setBusy(false); }
  }
  async function checkSend(clientMsgId: string) {
    if (!selected) return;
    try {
      const result = await gateway.byClientId(selected, clientMsgId);
      setNotice(`Gateway 已落地 · ${result.msgId} · ${result.sentAt}`);
      await loadGroup(selected);
    } catch (error) { setNotice(`Gateway 查询 ${clientMsgId}：${String(error)}`); }
  }
  const memberUsers = users.filter(user => group?.members.includes(user.platformUserId));
  const operatorUsers = memberUsers.filter(user => user.capabilities.includes('operate_group'));
  const sender = memberUsers.find(user => user.platformUserId === senderPlatformUserId);
  const visiblePending = pending.filter(item => !messages.some(message => message.clientMsgId === item.clientMsgId));
  const groupTitle = (item: GatewayGroup) => `群组 ${short(item.id)}`;
  const renderMedia = (message: GatewayMessage) => {
    const media = message.media;
    const url = media?.url || message.mediaUrl;
    if (!url) return null;
    if (media?.contentType.startsWith('image/')) return <a className="gateway-media image" href={url} target="_blank" rel="noreferrer"><img src={url} alt={media.fileName}/><span>{media.fileName} · {fileSize(media.size)}</span></a>;
    if (media?.contentType.startsWith('audio/')) return <div className="gateway-media"><audio controls src={url}/><a href={url} target="_blank" rel="noreferrer">{media.fileName}</a></div>;
    if (media?.contentType.startsWith('video/')) return <div className="gateway-media"><video controls src={url}/><a href={url} target="_blank" rel="noreferrer">{media.fileName}</a></div>;
    return <a className="gateway-media file" href={url} target="_blank" rel="noreferrer"><FileText size={22}/><span><strong>{media?.fileName || '媒体文件'}</strong><small>{media ? `${media.contentType} · ${fileSize(media.size)}` : '打开文件'}</small></span></a>;
  };
  return <section className="chat-v2 gateway-console" id="message-service">
    <header className="chat-v2-intro"><div><h2>Gateway 消息服务</h2></div><div className="chat-v2-intro-actions"><span className="gateway-stream">{streamStatus === '已连接' ? '●' : '○'} SSE {streamStatus}</span><div className="chat-v2-view-switch" role="tablist"><button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>会话</button><button className={view === 'users' ? 'active' : ''} onClick={() => setView('users')}>用户</button></div><Button variant="outline" onClick={() => void run('刷新', async () => { await loadOverview(); if (selectedRef.current) await loadGroup(selectedRef.current); })}><RefreshCw size={15}/>刷新</Button></div></header>
    {notice && <div role="status" className="gateway-notice">{notice}</div>}
    {view === 'users' ? <GatewayUsers users={users} groups={groups} canWrite={canWrite} onChanged={loadOverview}/> :
      <div className={`chat-v2-layout ${sidePanel ? 'has-info' : ''}`}><aside className="chat-v2-sidebar"><div className="chat-v2-sidebar-head"><strong>群组</strong><b>{groups.length}</b></div>{canWrite && <div className="gateway-create-group"><select aria-label="创建群的用户" value={creatorId} onChange={event => setCreatorId(event.target.value)}>{users.filter(user => user.status === 'online' && user.capabilities.includes('create_group')).map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><Button variant="outline" size="sm" disabled={busy || !creatorId} onClick={() => void run('创建群', async () => { const result = await gateway.createGroup(creatorId); setSelected(result.groupId); return result; }, false)}>新建群</Button></div>}{groups.map(item => <button key={item.id} className={`chat-v2-thread ${selected === item.id ? 'selected' : ''}`} onClick={() => setSelected(item.id)}><span className="chat-v2-avatar"><MessageSquareText size={17}/></span><span><strong>{groupTitle(item)}</strong><small>{item.members.length} 位成员 · {item.writable ? '可写' : '禁言'}</small></span><i className={item.writable ? 'ok' : 'warn'}/></button>)}</aside>
      <main className="chat-v2-main">{!group ? <div className="chat-v2-placeholder"><MessageSquareText size={42}/><h3>选择 Gateway 群</h3><p>数据直接来自 Gateway。</p></div> : <>
        <header className="chat-v2-header"><Button variant="ghost" size="icon-sm" aria-label="返回群列表" onClick={() => setSelected(null)}>‹</Button><span className="chat-v2-avatar"><MessageSquareText size={18}/></span><div><strong>{groupTitle(group)}</strong><small>{group.members.length} 位成员 · Gateway ID {group.id}</small></div><Button variant="outline" size="sm" onClick={() => setSidePanel(!sidePanel)}>{sidePanel ? '关闭' : '群管理'}</Button></header>
        <div ref={bodyRef} className="chat-v2-messages">{messages.length === 0 && visiblePending.length === 0 ? <div className="chat-v2-placeholder">暂无 Gateway 消息</div> : <>{messages.map(message => { const user = users.find(item => item.platformUserId === message.senderPlatformUserId); const isCurrentSender = message.senderPlatformUserId === senderPlatformUserId; return <div key={message.msgId} className={`chat-v2-message${isCurrentSender ? ' own' : ''}`}><div><b>{user?.displayName || message.senderPlatformUserId}</b>{renderMedia(message)}{message.text && <p>{message.text}</p>}<small>{new Date(message.sentAt).toLocaleString()} · {message.msgId}{message.clientMsgId ? ` · ${message.clientMsgId}` : ''}</small></div></div>; })}{visiblePending.map(item => <div key={item.clientMsgId} className="chat-v2-message own"><div><b>{item.accountId}</b>{item.mediaName && <div className="gateway-media pending"><FileText size={20}/><span>{item.mediaName}</span></div>}{item.text && <p>{item.text}</p>}<small>{item.status} · {item.clientMsgId}{item.error ? ` · ${item.error}` : ''}</small>{['accepted', 'unknown'].includes(item.status) && <button type="button" className="gateway-check-send" onClick={() => void checkSend(item.clientMsgId)}>按 clientMsgId 查询落地</button>}</div></div>)}</>}</div>
        <div className="gateway-send-mode gateway-send-unified"><strong>消息发送</strong><small>从当前群成员中选择用户，发送一条 Gateway 消息。</small></div>
        {attachment && <div className="gateway-attachment-draft" role="status"><FileText size={18}/><span><strong>{attachment.name}</strong><small>{attachment.type || 'application/octet-stream'} · {fileSize(attachment.size)}</small></span><button type="button" aria-label="移除待发送文件" onClick={() => setAttachment(null)}><X size={15}/></button></div>}
        <footer className="chat-v2-composer"><select aria-label="Gateway 消息发送用户" value={senderPlatformUserId} onChange={event => { const value = event.target.value; if (selected) senderByGroup.current.set(selected, value); setSenderPlatformUserId(value); }} disabled={!canWrite || busy || memberUsers.length === 0}><option value="">选择用户</option>{senderPlatformUserId && !sender && <option value={senderPlatformUserId} disabled>{users.find(user => user.platformUserId === senderPlatformUserId)?.displayName || senderPlatformUserId} · 已不在群中，请重新选择</option>}{memberUsers.map(user => <option value={user.platformUserId} key={user.platformUserId}>{user.displayName} · {user.platformUserId}</option>)}</select><input ref={fileRef} className="gateway-file-input" aria-label="Gateway 媒体文件" type="file" disabled={!canWrite || busy || !sender} onChange={event => { const file = event.target.files?.[0] || null; event.target.value = ''; if (file && file.size > 10 * 1024 * 1024) { setNotice('文件不能超过 10 MB'); return; } setAttachment(file); }}/><Button className="gateway-attach-button" variant="ghost" size="icon-sm" aria-label="添加媒体文件" title="添加媒体文件" disabled={!canWrite || busy || !sender} onClick={() => fileRef.current?.click()}><Paperclip size={18}/></Button><Input aria-label="Gateway 消息内容" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void send(); } }} placeholder={!canWrite ? '只读账号' : !sender ? '先选择群成员' : attachment ? '添加说明（可选）' : '输入消息'} disabled={!canWrite || busy || !sender}/><Button disabled={!canWrite || busy || !sender || (!text.trim() && !attachment)} onClick={() => void send()}>发送</Button></footer>
      </>}</main>
      {sidePanel && group && <aside className="chat-v2-info gateway-controls"><div><strong>群管理</strong><Button variant="ghost" size="icon-sm" onClick={() => setSidePanel(false)}>×</Button></div><section><small>群组 ID</small><code>{group.id}</code><p>群主：{group.owner}</p><p>写入：{group.writable ? '允许' : '禁止'}</p></section><section><strong>成员列表</strong>{group.members.map(pid => <div className="gateway-member" key={pid}><span>{users.find(user => user.platformUserId === pid)?.displayName || pid} · {pid}{group.owner === pid ? ' · 群主' : group.admins.includes(pid) ? ' · 管理员' : ''}</span></div>)}</section>{canWrite && <><section><strong>群与成员操作</strong><label>操作用户</label><select aria-label="Gateway 操作用户" value={operatorId} onChange={event => setOperatorId(event.target.value)}>{operatorUsers.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><label>目标用户</label><select aria-label="Gateway 目标成员" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">选择群成员</option>{memberUsers.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><div className="gateway-action-row"><Button variant="outline" size="sm" disabled={busy} onClick={() => void run('生成邀请链接', async () => { const result = await gateway.invite(group.id); setInviteLink(result.inviteLink); return result; })}>邀请</Button><Button variant="outline" size="sm" disabled={busy || !operatorId || !targetId} onClick={() => void run('提升管理员', () => gateway.promoteUser(group.id, operatorId, targetId))}>提升</Button><Button variant="outline" size="sm" disabled={busy || !operatorId || !targetId} onClick={() => void run('移除成员', () => gateway.kickUser(group.id, operatorId, targetId))}>踢出</Button><Button variant="outline" size="sm" disabled={busy || !operatorId} onClick={() => void run('用户退群', () => gateway.userLeave(operatorId, group.id))}>退群</Button></div><label>入群用户</label><select aria-label="Gateway 入群用户" value={joinAccountId} onChange={event => setJoinAccountId(event.target.value)}><option value="">选择用户</option>{users.filter(user => !group.members.includes(user.platformUserId)).map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select><Input aria-label="Gateway 邀请链接" value={inviteLink} onChange={event => setInviteLink(event.target.value)} placeholder="先生成邀请链接"/><Button variant="outline" size="sm" disabled={busy || !joinAccountId || !inviteLink} onClick={() => void run('提交 Gateway 入群', () => gateway.userJoin(joinAccountId, group.id, inviteLink))}>直接提交入群</Button></section><section><strong>群可写状态</strong><Button variant="outline" size="sm" disabled={busy} onClick={() => void run('设置群写入状态', () => gateway.writeStatus(group.id, !group.writable))}>{group.writable ? '设为不可写' : '恢复可写'}</Button></section></>}<section><strong>实时事件</strong>{eventLog.filter(event => !event.groupId || event.groupId === group.id).slice(0, 10).map(event => <small key={event.eventId}>#{event.eventId} · {event.type}</small>)}</section></aside>}</div>}
  </section>;
}
