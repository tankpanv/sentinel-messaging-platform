import { useState } from 'react';
import { gateway, type GatewayGroup, type GatewayUser } from '../api/gateway';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Props = {
  users: GatewayUser[];
  groups: GatewayGroup[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
};

function groupName(group: GatewayGroup) {
  return `群组 ${group.id.replace(/^gw-/, '').slice(0, 8)}`;
}

export function GatewayUsers({ users, groups, canWrite, onChanged }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [platformUserId, setPlatformUserId] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [details, setDetails] = useState<Record<string, GatewayUser>>({});
  const [targetGroups, setTargetGroups] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function act(label: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await action(); await onChanged(); setNotice(`${label}成功`); }
    catch (error) { setNotice(`${label}失败：${String(error)}`); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!displayName.trim()) return;
    await act('添加用户', async () => {
      await gateway.createUser(displayName.trim(), platformUserId.trim() || undefined);
      setDisplayName(''); setPlatformUserId('');
    });
  }

  async function join(user: GatewayUser, groupId: string) {
    const invitation = await gateway.invite(groupId);
    if (invitation.readyAfterMs > 0) await new Promise(resolve => window.setTimeout(resolve, invitation.readyAfterMs));
    return gateway.userJoin(user.id, groupId, invitation.inviteLink);
  }

  return <section className="gateway-user-accounts gateway-users" aria-label="Gateway 用户管理">
    <header><div><h3>用户 <span>{users.length}</span></h3><p>管理 Gateway 用户及其群成员关系。</p></div></header>
    {notice && <p className="gateway-user-notice" role="status">{notice}</p>}
    {canWrite && <div className="gateway-user-create">
      <Input aria-label="新用户名称" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="用户名称" maxLength={80}/>
      <Input aria-label="新用户 ID" value={platformUserId} onChange={event => setPlatformUserId(event.target.value)} placeholder="用户 ID（留空自动生成）" maxLength={128}/>
      <Button disabled={busy || !displayName.trim()} onClick={() => void create()}>添加用户</Button>
    </div>}
    {users.length === 0 ? <div className="gateway-user-empty">当前没有用户</div> : <div className="gateway-user-list">
      {users.map(user => {
        const joined = groups.filter(group => group.members.includes(user.platformUserId));
        const available = groups.filter(group => !group.members.includes(user.platformUserId));
        const targetGroupId = available.some(group => group.id === targetGroups[user.id]) ? targetGroups[user.id] : available[0]?.id || '';
        return <article className="gateway-user-card" key={user.id}>
          <div className="gateway-user-card-head"><div><strong>{user.displayName}</strong><small>{user.platformUserId} · 已加入 {joined.length} 个群</small></div><div className="gateway-user-card-actions">
            <Button variant="outline" size="sm" onClick={() => void act('读取用户详情', async () => { const value = await gateway.user(user.id); setDetails(old => ({ ...old, [user.id]: value })); })}>详情</Button>
            {canWrite && user.capabilities.includes('edit') && <Button variant="outline" size="sm" onClick={() => { setEditId(editId === user.id ? null : user.id); setEditName(user.displayName); }}>编辑</Button>}
            {canWrite && user.capabilities.includes('delete') && <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(`删除 ${user.displayName}？该用户会退出所有群，历史消息仍保留。`)) void act('删除用户', () => gateway.deleteUser(user.id)); }}>删除</Button>}
          </div></div>
          {details[user.id] && <div className="gateway-user-detail">Gateway 用户 ID：{details[user.id].id}</div>}
          {editId === user.id && canWrite && <div className="gateway-user-edit"><Input aria-label={`${user.displayName} 新名称`} value={editName} onChange={event => setEditName(event.target.value)} maxLength={80}/><Button disabled={busy || !editName.trim()} onClick={() => void act('更新用户名称', async () => { await gateway.updateUser(user.id, editName.trim()); setEditId(null); })}>保存</Button><Button variant="outline" onClick={() => setEditId(null)}>取消</Button><small>用户 ID 创建后不可修改。</small></div>}
          <div className="gateway-user-memberships"><strong>所在群</strong>{joined.length === 0 ? <small>尚未入群</small> : joined.map(group => <span key={group.id} className="gateway-user-membership">{groupName(group)}{canWrite && user.capabilities.includes('leave') && <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('用户退群', () => gateway.userLeave(user.id, group.id))}>退群</Button>}</span>)}</div>
          {canWrite && user.capabilities.includes('join') && <div className="gateway-user-join"><select aria-label={`${user.displayName} 要加入的群`} value={targetGroupId} onChange={event => setTargetGroups(old => ({ ...old, [user.id]: event.target.value }))} disabled={busy || available.length === 0}>{available.length === 0 ? <option value="">没有可加入的群</option> : available.map(group => <option key={group.id} value={group.id}>{groupName(group)} · {group.members.length} 位成员</option>)}</select><Button variant="outline" disabled={busy || !targetGroupId} onClick={() => void act('用户入群', () => join(user, targetGroupId))}>加入群</Button></div>}
        </article>;
      })}
    </div>}
  </section>;
}
