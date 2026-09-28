import { Button } from './ui/button';
import { Card } from './ui/card';
import { useEffect, useState } from 'react';
import { client, errorText } from '../api/client';
import type { Account } from '../generated';
import { Users } from 'lucide-react';

export function GroupCreation({ onCreated, refreshKey }: { onCreated: () => void; refreshKey: number }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [creator, setCreator] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  useEffect(() => { void client.listAccounts().then(setAccounts).catch(async value => setError(await errorText(value))); }, [refreshKey]);
  useEffect(() => {
    if (!jobId || status === 'finished' || status === 'failed') return;
    const timer = window.setInterval(async () => {
      try {
        const job = await client.getJob({ id: jobId });
        setStatus(job.status);
        setProgress((job.progress || {}) as Record<string, unknown>);
        if (job.status === 'finished') onCreated();
        if (job.status === 'failed') setError((job.errors || []).map(item => `${item.step}: ${item.code}`).join('；'));
      } catch (value) { setError(await errorText(value)); }
    }, 500);
    return () => window.clearInterval(timer);
  }, [jobId, status, onCreated]);
  const online = accounts.filter(account => account.status === 'online');
  return <Card className="panel create-panel">
    <div className="section-title"><div><h2>创建群组</h2><p className="section-kicker">在线账号可参与建群</p></div><div className="mini-icon"><Users size={17}/></div></div>
    <div className="create-fields"><label>群主<select value={creator} onChange={event => { setCreator(event.target.value); setMembers(previous => previous.filter(id => id !== event.target.value)); }}><option value="">选择创建账号</option>{online.map(account => <option key={account.id} value={account.id}>{account.id}</option>)}</select></label>
    <div><span className="field-label">群组成员 <small>· 第一个成员将设为管理员</small></span><div className="member-options">{online.filter(account => account.id !== creator).map(account => <label key={account.id}><input type="checkbox" checked={members.includes(account.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, account.id] : previous.filter(id => id !== account.id))} />{account.id}</label>)}</div></div>
    <Button disabled={!creator || !members.length || status === 'running'} onClick={async () => { try { setError(''); const job = await client.createGroup({ createGroupRequest: { creatorAccountId: creator, memberAccountIds: members } }); setJobId(job.jobId); setStatus('running'); } catch (value) { setError(await errorText(value)); } }}>创建群组</Button></div>
    {jobId && <p className="muted">任务 {jobId.slice(0, 8)} · {status}{progress.step ? ` · ${String(progress.step)}` : ''}{Array.isArray(progress.completedMemberAccountIds) ? ` · 已入群 ${progress.completedMemberAccountIds.length}/${members.length}` : ''}{progress.currentAccountId ? ` · ${String(progress.currentAccountId)}` : ''}</p>}
    {progress.lastFailure && typeof progress.lastFailure === 'object' && <p className="error">最近失败：{String((progress.lastFailure as {step?:unknown}).step || '')} · {String((progress.lastFailure as {code?:unknown}).code || '')}（{status === 'running' ? '任务正在重试' : '任务已失败'}）</p>}
    {error && <p className="error">{error}</p>}
  </Card>;
}
