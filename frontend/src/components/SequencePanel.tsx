import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useEffect, useRef, useState } from 'react';
import { client, errorText } from '../api/client';
import type { Group, Sequence, SequenceRun, SequenceStepInput } from '../generated';
import { useEvents } from '../hooks/useEvents';

const example = JSON.stringify([
  { index: 1, accountRole: 'admin', text: '{event} 即将开始', delaySeconds: 0 },
  { index: 2, accountRole: 'member', text: '资料已上传到 {location}', delaySeconds: 5 },
], null, 2);
type Preview = { index: number; text: string; senderAccountId?: string; values: Record<string, string>; sources: Record<string, string> };
type Prepared = { values: Record<string, string>; overrides: Record<string, Record<string, string>>; senderAccountIds: Record<string, string>; steps: SequenceStepInput[] };
function variablesFor(steps: SequenceStepInput[]) {
  return Array.from(new Set(steps.flatMap(step => Array.from(step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g), match => match[1]))));
}
function parseObject(source: string): Record<string, any> {
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('变量必须是 JSON 对象');
  return value;
}

type SequenceRoute = { nav: string; action?: 'create' | 'edit' | 'run'; id?: string };
const runStatusLabel: Record<string, string> = { running: '运行中', finished: '已完成', failed: '失败', stopped: '已停止', pending: '等待中', accepted: '已受理', sent: '已发送', skipped: '已跳过' };
function SequenceRunCard({ run, title }: { run: SequenceRun; title?: string }) {
  return <article className="sequence-history-card" data-run-id={run.id}>
    <header><div><strong>{title || '运行记录'} · {run.id?.slice(0, 8)}</strong><small>模板 {run.sequenceId?.slice(0, 8) || '—'} · {run.createdAt ? `创建于 ${new Date(run.createdAt).toLocaleString()}` : '创建时间未记录'} · 当前步骤 {run.currentStepIndex >= run.steps.length ? '已完成' : `第 ${run.currentStepIndex + 1} 步`}</small></div><span className={`status sequence-run-status ${run.status}`}>{runStatusLabel[run.status] || run.status}</span></header>
    <div className="sequence-run-step-list">{run.steps.map((raw, index) => {
      const step = raw as Record<string, any>;
      const values = (step.resolvedVars || {}) as Record<string, string>;
      const sources = (step.varSources || {}) as Record<string, string>;
      return <section className="sequence-history-step" key={index}>
        <div className="sequence-history-step-head"><strong>第 {Number(step.index || index + 1)} 步</strong><span className={`status ${String(step.status || 'pending')}`}>{runStatusLabel[String(step.status)] || String(step.status || 'pending')}</span></div>
        <p>{String(step.text || '—')}</p>
        <div className="sequence-history-step-meta"><span>默认角色：{step.accountRole === 'admin' ? '管理员' : '成员'}</span><span>指定账号：{String(step.senderAccountId || '自动选择')}</span><span>实际账号：{String(step.accountId || '尚未发送')}</span><span>延迟：{String(step.delaySeconds ?? 0)} 秒</span><span>计划：{step.scheduledAt ? new Date(step.scheduledAt).toLocaleString() : '—'}</span><span>发出：{step.sentAt ? new Date(step.sentAt).toLocaleString() : '—'}</span>{step.clientMsgId && <span>clientMsgId：{String(step.clientMsgId)}</span>}</div>
        {Object.keys(values).length > 0 && <div className="sequence-vars">{Object.entries(values).map(([key, value]) => <span key={key}>{key} = {value} · 来源 {sources[key] || '—'}</span>)}</div>}
      </section>;
    })}</div>
  </article>;
}
export function SequencePanel({ route, groupId, groups, canWrite, onNavigate }: { route: SequenceRoute; groupId: string; groups: Group[]; canWrite: boolean; onNavigate: (path: string) => void }) {
  const [targetGroupId, setTargetGroupId] = useState(groupId || groups.find(group => group.status === 'active')?.id || groups[0]?.id || '');
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('活动提醒');
  const [stepSource, setStepSource] = useState(example);
  const [draftSteps, setDraftSteps] = useState<SequenceStepInput[]>(JSON.parse(example));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [creatorNotice, setCreatorNotice] = useState('');
  const creatorRef = useRef<HTMLDivElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [page, setPage] = useState<'list' | 'template' | 'run'>('list');
  const [varsSource, setVarsSource] = useState('{"event":"演示活动","location":"共享盘"}');
  const [stepVarsSource, setStepVarsSource] = useState('{}');
  const [senderOverrides, setSenderOverrides] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [run, setRun] = useState<SequenceRun | null>(null);
  const [history, setHistory] = useState<SequenceRun[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [availabilityKnown, setAvailabilityKnown] = useState(false);
  const [activeRun, setActiveRun] = useState<SequenceRun | null>(null);
  const historyRequest = useRef(0);
  const [error, setError] = useState('');
  const initializedRoute = useRef('');
  const activeGroupId = targetGroupId;

  useEffect(() => { if (groupId) setTargetGroupId(groupId); }, [groupId]);
  useEffect(() => {
    if (!groupId && !targetGroupId && groups.length > 0) setTargetGroupId(groups.find(group => group.status === 'active')?.id || groups[0].id);
  }, [groupId, groups, targetGroupId]);

  const loadRun = async (runId: string) => {
    try { const next = await client.getSequenceRun({ id: runId }); setRun(next); setActiveRun(next.status === 'running' ? next : null); setError(''); }
    catch (value) { setError(await errorText(value)); }
  };
  const loadHistory = async (reset = true) => {
    if (!activeGroupId || !selected) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    try {
      const [page, active] = await Promise.all([
        client.listSequenceRuns({ id: activeGroupId, sequenceId: selected, limit: 8, before: reset ? undefined : historyCursor || undefined }),
        client.getActiveSequenceRun({ id: activeGroupId }),
      ]);
      if (request !== historyRequest.current) return;
      setHistory(previous => reset ? page.items : [...previous, ...page.items]);
      setHistoryCursor(page.nextCursor || null);
      // Concurrency is scoped to the group, so an active run from another
      // template must also block this page from starting a new run.
      const running = active.run || null;
      if (reset) { setActiveRun(running); if (running) setRun(running); else setRun(null); }
      setAvailabilityKnown(true);
      return running;
    } catch (value) { if (request === historyRequest.current) { setAvailabilityKnown(false); setError(await errorText(value)); } return; }
    finally { if (request === historyRequest.current) setHistoryLoading(false); }
  };
  useEffect(() => {
    void client.listSequences().then(setSequences).catch(async value => setError(await errorText(value)));
  }, []);
  useEffect(() => {
    if (route.nav !== 'sequence') return;
    const key = `${route.action || 'list'}:${route.id || ''}`;
    if (initializedRoute.current === key) return;
    initializedRoute.current = key;
    if (!route.action) {
      setPage('list'); setEditorOpen(false); return;
    }
    if (route.action === 'create') {
      setPage('template'); setEditorOpen(true); setSelected(''); setName('活动提醒'); setDraftSteps(JSON.parse(example)); setStepSource(example); setSenderOverrides({}); setPreview(null); setPrepared(null); setError(''); setCreatorNotice(''); return;
    }
    const sequenceId = route.id;
    if (!sequenceId) return;
    // The route ID is the source of truth. Never reuse the previous template
    // while the list request is still loading or while navigating between IDs.
    setPage(route.action === 'run' ? 'run' : 'template');
    setEditorOpen(true); setSelected(sequenceId); setName(''); setDraftSteps([]); setStepSource('[]'); setSenderOverrides({}); setPreview(null); setPrepared(null); setRun(null); setError('');
    let cancelled = false;
    void client.getSequence({ id: sequenceId }).then(item => {
      if (cancelled) return;
      setSequences(previous => previous.some(sequence => sequence.id === item.id) ? previous.map(sequence => sequence.id === item.id ? item : sequence) : [...previous, item]);
      setSelected(item.id); setName(item.name); setDraftSteps(item.steps); setStepSource(JSON.stringify(item.steps, null, 2));
    }).catch(async value => { if (!cancelled) setError(await errorText(value)); });
    return () => { cancelled = true; };
  }, [route.nav, route.action, route.id]);
  useEffect(() => {
    historyRequest.current++;
    setRun(null); setActiveRun(null); setHistory([]); setHistoryCursor(null); setAvailabilityKnown(false);
    if (activeGroupId && selected) void loadHistory(true);
  }, [activeGroupId, selected]);
  useEvents((type, payload) => {
    if (type !== 'sequence_run') return;
    const event = (payload || {}) as { runId?: string; groupId?: string };
    if (event.groupId !== activeGroupId && event.runId !== run?.id) return;
    void loadHistory(true);
  });
  useEffect(() => {
    if (!activeRun?.id || activeRun.status !== 'running') return;
    const timer = window.setInterval(() => { void client.getSequenceRun({ id: activeRun.id! }).then(next => { if (next.status === 'running') { setRun(next); setActiveRun(next); } else { setRun(null); setActiveRun(null); void loadHistory(true); } }).catch(async value => setError(await errorText(value))); }, 1000);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status]);

  const steps = () => draftSteps;
  const targetGroup = groups.find(group => group.id === activeGroupId);
  const selectedSequence = sequences.find(item => item.id === selected);
  const currentEmptyText = !activeGroupId ? '请选择目标群组' : !availabilityKnown ? '正在读取运行状态…' : '当前群组没有运行中的序列';
  const historyEmptyText = !activeGroupId ? '请选择目标群组' : historyLoading ? '正在加载历史运行…' : !availabilityKnown ? '暂时无法读取历史运行' : '暂无历史运行记录';
  const showError = async (value: unknown) => {
    const response = (value as { response?: Response }).response;
    const body = await response?.clone().json().catch(() => null);
    if (body?.error?.code === 'UNRESOLVED_PLACEHOLDER') setError(`第 ${body.error.stepIndex} 步缺少变量 ${body.error.key}`);
    else setError(await errorText(value));
  };
  const prepare = async () => {
    const running = await loadHistory(true);
    if (running === undefined) return;
    if (running) { setShowPreview(false); setError(`当前群组已有运行中的序列（${running.id?.slice(0, 8) || '未知'}），请等待完成后再启动。`); return; }
    const values = parseObject(varsSource) as Record<string, string>;
    const overrides = parseObject(stepVarsSource) as Record<string, Record<string, string>>;
    const selectedSteps = steps();
    const senderAccountIds = Object.fromEntries(selectedSteps.map(step => [String(step.index), senderOverrides[String(step.index)] ?? step.senderAccountId ?? '']));
    const missingMember = selectedSteps.find(step => senderAccountIds[String(step.index)] && !(targetGroup?.members || []).some(member => member.accountId === senderAccountIds[String(step.index)]));
    if (missingMember) throw new Error(`第 ${missingMember.index} 步指定的账号 ${senderAccountIds[String(missingMember.index)]} 不是当前群组成员`);
    const response = await client.previewSequence({ sequencePreviewInput: { steps: selectedSteps, vars: values, stepVars: overrides, stepAccountIds: senderAccountIds } });
    setPreview(response.steps.map(step => ({ index: step.index || 0, text: step.text || '', senderAccountId: step.senderAccountId, values: step.resolvedVars || {}, sources: step.varSources || {} })));
    setError(''); setPrepared({ values, overrides, senderAccountIds, steps: selectedSteps }); setShowPreview(true);
  };
  const resetDraft = () => {
    onNavigate('sequence/create'); setEditorOpen(true); setPage('template'); setSelected(''); setName('活动提醒'); setDraftSteps(JSON.parse(example)); setStepSource(example);
    setVarsSource('{"event":"演示活动","time":"14:00","location":"共享盘"}'); setStepVarsSource('{}');
    setPreview(null); setPrepared(null); setSenderOverrides({}); setError(''); setShowAdvanced(false); setCreatorNotice('已打开新的序列模板编辑器');
    window.setTimeout(() => creatorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const editSequence = (id: string) => {
    const item = sequences.find(sequence => sequence.id === id);
    if (!item) return;
    onNavigate(`sequence/edit/${id}`); setSelected(id); setName(item.name); setDraftSteps(item.steps); setStepSource(JSON.stringify(item.steps, null, 2));
    setPreview(null); setPrepared(null); setSenderOverrides({}); setError(''); setCreatorNotice(''); setEditorOpen(true); setPage('template');
  };
  const openRun = (id: string) => {
    const item = sequences.find(sequence => sequence.id === id);
    if (!item) return;
    onNavigate(`sequence/run/${id}`); setSelected(id); setName(item.name); setDraftSteps(item.steps); setStepSource(JSON.stringify(item.steps, null, 2));
    setPreview(null); setPrepared(null); setSenderOverrides({}); setError(''); setCreatorNotice(''); setEditorOpen(true); setPage('run');
  };
  const updateDraft = (index: number, patch: Partial<SequenceStepInput>) => {
    const next = draftSteps.map((step, itemIndex) => itemIndex === index ? { ...step, ...patch } : step);
    setDraftSteps(next); setStepSource(JSON.stringify(next, null, 2)); setPreview(null); setPrepared(null);
  };
  const addDraftStep = () => {
    const next = [...draftSteps, { index: draftSteps.length + 1, accountRole: 'member', text: '', delaySeconds: 5 }];
    setDraftSteps(next); setStepSource(JSON.stringify(next, null, 2));
  };
  const removeDraftStep = (index: number) => {
    const next = draftSteps.filter((_, itemIndex) => itemIndex !== index).map((step, itemIndex) => ({ ...step, index: itemIndex + 1 }));
    setDraftSteps(next); setStepSource(JSON.stringify(next, null, 2)); setPreview(null); setPrepared(null);
  };
  const saveSequence = async () => {
    try {
      if (!name.trim()) throw new Error('请填写序列名称');
      const wasNew = !selected;
      const saved = selected
        ? await client.updateSequence({ id: selected, sequenceInput: { name: name.trim(), steps: draftSteps } })
        : await client.createSequence({ sequenceInput: { name: name.trim(), steps: draftSteps } });
      const items = await client.listSequences(); setSequences(items); setSelected(saved.id); setStepSource(JSON.stringify(draftSteps, null, 2)); setCreatorNotice(wasNew ? '序列模板已创建。' : '序列模板已更新。'); setError(''); onNavigate(`sequence/edit/${saved.id}`);
    } catch (value) { await showError(value); }
  };
  const start = async () => {
    if (!prepared || !canWrite) return;
    try {
      const running = await loadHistory(true);
      if (running === undefined) { setShowPreview(false); return; }
      if (running) { setShowPreview(false); setError(`当前群组已有运行中的序列（${running.id?.slice(0, 8) || '未知'}），请等待完成后再启动。`); return; }
      let sequenceId = selected;
      if (!sequenceId) {
        const created = await client.createSequence({ sequenceInput: { name, steps: prepared.steps } });
        sequenceId = created.id;
        setSequences(await client.listSequences()); setSelected(sequenceId);
      }
      const started = await client.startSequence({ id: activeGroupId, startSequence: { sequenceId, vars: prepared.values, stepVars: prepared.overrides, stepAccountIds: prepared.senderAccountIds } });
      await loadRun(started.runId); await loadHistory(true); setShowPreview(false);
    } catch (value) { await showError(value); await loadHistory(true); }
  };

  if (page === 'list') return <Card className="panel sequence-panel sequence-list-page">
    <div className="section-title"><div><div className="eyebrow">AUTOMATION LIBRARY</div><h2>序列模板</h2><span className="muted">管理可复用的定时消息流程，保存后绑定群组执行</span></div>{canWrite && <Button onClick={resetDraft}>＋ 创建序列模板</Button>}</div>
    <div className="sequence-list-toolbar"><div><strong>{sequences.length}</strong><span>个已保存模板</span></div><small>模板只保存步骤定义，不会自动发送消息。</small></div>
    {sequences.length === 0 ? <div className="sequence-empty"><strong>还没有序列模板</strong><small>点击右上角“创建序列模板”，开始配置第一套自动化流程。</small>{canWrite && <Button variant="outline" onClick={resetDraft}>创建第一个模板</Button>}</div> : <div className="sequence-template-grid">{sequences.map(item => <article className="sequence-template-card" data-sequence-id={item.id} key={item.id}><div className="sequence-template-card-head"><div><span className="sequence-template-icon">⚡</span><div><h3>{item.name}</h3><small>{item.steps.length} 个步骤 · 保存后可用于新运行</small></div></div><span className="sequence-template-id">{item.id.slice(0, 8)}</span></div><div className="sequence-template-summary">{item.steps.slice(0, 3).map(step => <div key={step.index}><b>{step.index}</b><span>{step.accountRole === 'admin' ? '管理员' : '成员'} · {step.text || '未填写消息'}</span><small>{step.delaySeconds}s</small></div>)}</div><div className="sequence-template-actions">{canWrite && <Button variant="outline" size="sm" onClick={() => editSequence(item.id)}>编辑模板</Button>}<Button size="sm" onClick={() => openRun(item.id)}>运行序列 <span>→</span></Button></div></article>)}</div>}
  </Card>;

  if (page === 'template') return <Card className="panel sequence-panel sequence-editor-page">
    <div className="section-title"><div><Button className="sequence-back-button" variant="ghost" size="sm" onClick={() => { onNavigate('sequence'); setEditorOpen(false); setPage('list'); setCreatorNotice(''); }}>← 返回模板列表</Button><h2>{selected ? '编辑序列模板' : '创建序列模板'}</h2><span className="muted">这里只定义模板步骤；群组和变量在“运行序列”页面填写</span></div><div className="sequence-header-actions">{canWrite && <Button onClick={() => void saveSequence()}>{selected ? '保存修改' : '保存模板'}</Button>}</div></div>
    {creatorNotice && <p className="sequence-notice" role="status">{creatorNotice}</p>}
    {canWrite && <div className="sequence-create-banner"><div><strong>模板内容</strong><small>变量写在消息文本中，格式为 {'{变量名}'}。</small></div><span>模板不会自动发送，保存后从列表点击“运行序列”。</span></div>}
    <div ref={creatorRef} id="sequence-creator" />
    {canWrite && <>
      <label>序列名称<Input aria-label="序列名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：季度会议提醒" /></label>
      <div className="sequence-builder">
        <div className="sequence-builder-head"><div><strong>消息步骤</strong><small>按顺序执行，下一步会在上一步真实送达后计时。</small></div><Button variant="outline" size="sm" onClick={addDraftStep}>＋ 添加步骤</Button></div>
        {draftSteps.map((step, index) => <article className="sequence-builder-step" key={`${step.index}-${index}`}>
          <div className="sequence-step-number">{index + 1}</div>
          <div className="sequence-step-fields">
            <div className="sequence-step-row"><label>账号角色<select aria-label={`第 ${index + 1} 步账号角色`} value={step.accountRole} onChange={event => updateDraft(index, { accountRole: event.target.value })}><option value="admin">管理员</option><option value="member">成员</option></select></label><label>等待秒数<input aria-label={`第 ${index + 1} 步等待秒数`} type="number" min="0" value={step.delaySeconds} onChange={event => updateDraft(index, { delaySeconds: Math.max(0, Number(event.target.value) || 0) })} /></label></div>
            <label>默认发送成员 ID（可选）<Input aria-label={`第 ${index + 1} 步默认发送成员 ID`} value={step.senderAccountId || ''} onChange={event => updateDraft(index, { senderAccountId: event.target.value || undefined })} placeholder="例如 acc-2；留空按角色自动选择" /></label>
            <small className="field-help">填写群内服务账号的 accountId。指定后优先用该账号，运行时仍可改。</small>
            <label>消息内容<Input aria-label={`第 ${index + 1} 步消息内容`} value={step.text} onChange={event => updateDraft(index, { text: event.target.value })} placeholder="例如：活动 {event} 将于 {time} 开始" /></label>
            <small className="sequence-variable-hint">{variablesFor([step]).length ? <>本步骤识别到变量：{variablesFor([step]).map(variable => <code key={variable}>{`{${variable}}`}</code>)}</> : '还没有变量；需要动态内容时，可在文本中输入 {变量名}。'}</small>
          </div>
          {draftSteps.length > 1 && <Button variant="ghost" size="sm" onClick={() => removeDraftStep(index)}>删除</Button>}
        </article>)}
      </div>
      <div className="sequence-variable-guide"><strong>变量怎么用</strong><p>变量名由消息里的 {'{变量名}'} 自动识别，只允许字母、数字和下划线。例如消息写成“{`{event}`} 将于 {`{time}`} 开始”，运行时就需要填写 event 和 time。</p><div className="sequence-variable-chips">{variablesFor(draftSteps).length ? variablesFor(draftSteps).map(variable => <code key={variable}>{`{${variable}}`}</code>) : <small>当前模板还没有变量</small>}</div></div>
      <button type="button" className="sequence-advanced-toggle" onClick={() => setShowAdvanced(value => !value)}>{showAdvanced ? '收起高级 JSON 编辑' : '使用高级 JSON 编辑'}</button>
      {showAdvanced && <label>步骤 JSON<Textarea className="code-input" value={stepSource} onChange={event => { setStepSource(event.target.value); try { setDraftSteps(JSON.parse(event.target.value)); } catch {} }} /></label>}
      <div className="actions"><Button variant="outline" disabled={!name.trim() || draftSteps.length === 0} onClick={() => void saveSequence()}>{selected ? '保存修改' : '保存序列模板'}</Button></div>
    </>}
    {error && <p className="error">{error}</p>}
  </Card>;

  return <Card className="panel sequence-panel sequence-editor-page sequence-run-page">
    <div className="section-title"><div><Button className="sequence-back-button" variant="ghost" size="sm" onClick={() => { onNavigate('sequence'); setEditorOpen(false); setPage('list'); setCreatorNotice(''); }}>← 返回模板列表</Button><h2>运行序列 · {selectedSequence?.name || '模板不存在'}</h2><span className="muted">模板 ID：{selectedSequence?.id || selected || '—'} · 选择群组和本次运行参数，预检通过后才会发送消息</span></div></div>
    <label>执行模板<select aria-label="执行模板" value={selected} onChange={event => openRun(event.target.value)}>{sequences.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>目标群组<select aria-label="目标群组" value={activeGroupId} onChange={event => { setTargetGroupId(event.target.value); setSenderOverrides({}); setPreview(null); setPrepared(null); setRun(null); setError(''); }}><option value="">选择目标群组</option>{groups.map(group => <option key={group.id} value={group.id}>群组 {group.id.slice(0, 8)} · {group.status === 'active' ? '运行中' : '不可用'}</option>)}</select></label>
    {activeRun && <div className="sequence-active-warning" role="status"><div><strong>当前群组已有运行中的序列</strong><span>运行 {activeRun.id?.slice(0, 8)} 正在执行，完成后才能启动新的运行。</span></div><span className="status running">运行中</span></div>}
    <div className="sequence-run-workspace">
    <div className="sequence-run-monitor">
    <section className="sequence-current-run"><div className="sequence-run-section-head"><div><h3>当前运行</h3><small>实时同步步骤状态、账号、计划时间和实际发出时间。</small></div>{run && <span className="status sequence-run-status">{runStatusLabel[run.status] || run.status}</span>}</div>{run ? <SequenceRunCard run={run} title="当前运行" /> : <div className="sequence-history-empty">{currentEmptyText}</div>}</section>
    <section className="sequence-history"><div className="sequence-run-section-head"><div><h3>历史运行</h3><small>按创建时间倒序展示；每条记录保留完整步骤信息。</small></div><Button variant="outline" size="sm" disabled={historyLoading || !activeGroupId || !selected} onClick={() => void loadHistory(true)}>刷新</Button></div>{history.filter(item => item.id !== run?.id).length === 0 ? <div className="sequence-history-empty">{historyEmptyText}</div> : <div className="sequence-history-list">{history.filter(item => item.id !== run?.id).map(item => <SequenceRunCard key={item.id} run={item} />)}</div>}{historyCursor && <div className="sequence-history-more"><Button variant="outline" size="sm" disabled={historyLoading} onClick={() => void loadHistory(false)}>{historyLoading ? '加载中…' : '加载更早运行'}</Button></div>}</section>
    </div>
    <div className="sequence-run-configuration">
    <section className="sequence-run-plan">
      <div><strong>本次运行步骤</strong><small>每一步可指定群内服务账号 ID；留空则按模板角色自动选择。</small></div>
      {draftSteps.length === 0 ? <div className="sequence-history-empty">正在读取模板步骤…</div> : draftSteps.map((step, index) => <article className="sequence-run-plan-step" key={step.index}>
        <div className="sequence-run-plan-step-head"><strong>第 {index + 1} 步</strong><span>{step.accountRole === 'admin' ? '管理员' : '成员'} · 等待 {step.delaySeconds} 秒</span></div>
        <p>{step.text}</p>
        <label>指定发送成员 ID<Input aria-label={`第 ${index + 1} 步指定发送成员 ID`} list={`sequence-member-options-${index}`} disabled={!canWrite} value={senderOverrides[String(step.index)] ?? step.senderAccountId ?? ''} onChange={event => { setSenderOverrides(previous => ({ ...previous, [String(step.index)]: event.target.value })); setPreview(null); setPrepared(null); }} placeholder="留空按角色自动选择" /></label>
        <datalist id={`sequence-member-options-${index}`}>{(targetGroup?.members || []).map(member => <option key={member.accountId} value={member.accountId}>{member.role}</option>)}</datalist>
        <small>可填写：{(targetGroup?.members || []).map(member => member.accountId).join('、') || '当前群组暂无服务账号'}。指定账号不在群或不可用时，该步会跳过。</small>
      </article>)}
    </section>
    <div className="sequence-run-guide"><strong>本次运行变量</strong><span>vars 是所有步骤的默认值；stepVars 可从指定步骤开始覆盖某个值。变量名称来自模板消息中出现的 {'{变量名}'}。</span><div className="sequence-variable-chips">{variablesFor(draftSteps).length ? variablesFor(draftSteps).map(variable => <code key={variable}>{`{${variable}}`}</code>) : <small>当前模板不需要变量。</small>}</div></div>
    {canWrite && <div className="form-columns"><label>vars<Textarea aria-label="vars" className="code-input" value={varsSource} onChange={event => { setVarsSource(event.target.value); setPreview(null); setPrepared(null); }} placeholder={'例如：{"event":"季度会议","time":"14:00"}'} /><small className="field-help">全局默认值，所有步骤都可使用。</small></label><label>stepVars<Textarea aria-label="stepVars" className="code-input" value={stepVarsSource} onChange={event => { setStepVarsSource(event.target.value); setPreview(null); setPrepared(null); }} placeholder={'例如：{"2":{"location":"共享盘"}}'} /><small className="field-help">按步骤覆盖，例如第 2 步开始使用新的 location。</small></label></div>}
    {canWrite && <><div className="actions"><Button className="subtle" disabled={targetGroup?.status !== 'active' || !availabilityKnown || historyLoading || Boolean(activeRun)} onClick={() => { void prepare().catch(showError); }}>预检变量与消息</Button><Button disabled={!prepared || targetGroup?.status !== 'active' || !availabilityKnown || historyLoading || Boolean(activeRun)} onClick={() => { if (prepared) setShowPreview(true); else void prepare().catch(showError); }}>启动序列</Button></div>{!activeGroupId && <small className="muted">请选择运行中的群组后才能预检和启动。</small>}{activeGroupId && targetGroup?.status !== 'active' && <small className="muted">当前群组不可用，恢复运行后才能启动序列。</small>}{activeGroupId && !availabilityKnown && targetGroup?.status === 'active' && <small className="muted">正在检查群组是否已有运行中的序列…</small>}{activeRun && <small className="muted">已有运行时，启动按钮会保持禁用；系统也会在提交前再次检查。</small>}</>}
    {error && <p className="error">{error}</p>}
    {showPreview && preview && <div className="sequence-preview-backdrop"><div className="sequence-preview-dialog" role="dialog" aria-modal="true" aria-label="序列预检结果"><h3>序列预检结果</h3><p>确认每一步的发送账号、最终文本、变量值和来源后启动。</p><div className="sequence-preview-steps">{preview.map(step => <article key={step.index}><strong>第 {step.index} 步 · {step.text}</strong><small>发送账号：{step.senderAccountId || '按角色自动选择'}</small>{Object.entries(step.values).map(([key, value]) => <small key={key}>{key} = {value} · 来源：{step.sources[key]}</small>)}</article>)}</div><div className="actions"><Button variant="outline" onClick={() => setShowPreview(false)}>返回运行设置</Button><Button onClick={() => void start()}>确认启动</Button></div></div></div>}
    </div>
    </div>
  </Card>;
}
