import { Button } from './ui/button';
import { Card } from './ui/card';
import { useEffect, useState } from 'react';
import { client, errorText } from '../api/client';
import type { Account } from '../generated';

export function GroupCreation({ onCreated, refreshKey }: { onCreated: () => void; refreshKey: number }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [creator, setCreator] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void client.listAccounts().then(setAccounts).catch(async value => setError(await errorText(value))); }, [refreshKey]);
  useEffect(() => {
    if (!jobId || status === 'finished' || status === 'failed') return;
    const timer = window.setInterval(async () => {
      try {
        const job = await client.getJob({ id: jobId });
        setStatus(job.status);
        if (job.status === 'finished') onCreated();
        if (job.status === 'failed') setError((job.errors || []).map(item => `${item.step}: ${item.code}`).join('；'));
      } catch (value) { setError(await errorText(value)); }
    }, 500);
    return () => window.clearInterval(timer);
  }, [jobId, status, onCreated]);
  const online = accounts.filter(account => account.status === 'online');
  return <Card className="panel">
    <div className="section-title"><h2>创建群组</h2><span className="muted">在线账号可参与建群</span></div>
    <div className="toolbar"><label>群主<select value={creator} onChange={event => { setCreator(event.target.value); setMembers(previous => previous.filter(id => id !== event.target.value)); }}><option value="">选择账号</option>{online.map(account => <option key={account.id} value={account.id}>{account.id}</option>)}</select></label>
    <div><span className="field-label">成员（第一个为管理员）</span><div className="member-options">{online.filter(account => account.id !== creator).map(account => <label key={account.id}><input type="checkbox" checked={members.includes(account.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, account.id] : previous.filter(id => id !== account.id))} />{account.id}</label>)}</div></div>
    <Button disabled={!creator || !members.length || status === 'running'} onClick={async () => { try { setError(''); const job = await client.createGroup({ createGroupRequest: { creatorAccountId: creator, memberAccountIds: members } }); setJobId(job.jobId); setStatus('running'); } catch (value) { setError(await errorText(value)); } }}>创建</Button></div>
    {jobId && <p className="muted">任务 {jobId.slice(0, 8)} · {status}</p>}{error && <p className="error">{error}</p>}
  </Card>;
}
