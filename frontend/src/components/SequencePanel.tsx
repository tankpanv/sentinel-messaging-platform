import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useEffect, useState } from 'react';
import { client, errorText } from '../api/client';
import type { Sequence, SequenceRun, SequenceStepInput } from '../generated';

const example = JSON.stringify([
  { index: 1, accountRole: 'admin', text: '{event} 即将开始', delaySeconds: 0 },
  { index: 2, accountRole: 'member', text: '资料已上传到 {location}', delaySeconds: 5 },
], null, 2);
type Preview = { index: number; text: string; values: Record<string, string>; sources: Record<string, string> };
function parseObject(source: string): Record<string, string> {
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('变量必须是 JSON 对象');
  return value;
}
function previewSteps(steps: SequenceStepInput[], defaults: Record<string, string>, stepVars: Record<string, Record<string, string>>): Preview[] {
  const values: Record<string, string> = {}; const sources: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) if (value !== '') { values[key] = value; sources[key] = 'default'; }
  return steps.map(step => {
    for (const [key, value] of Object.entries(stepVars[String(step.index)] || {})) if (value !== '') { values[key] = value; sources[key] = `step:${step.index}`; }
    const text = step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
      if (values[key] === undefined) throw new Error(`第 ${step.index} 步缺少 ${key}`);
      return values[key];
    });
    return { index: step.index, text, values: { ...values }, sources: { ...sources } };
  });
}

export function SequencePanel({ groupId }: { groupId: string }) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('活动提醒');
  const [stepSource, setStepSource] = useState(example);
  const [varsSource, setVarsSource] = useState('{"event":"演示活动","location":"共享盘"}');
  const [stepVarsSource, setStepVarsSource] = useState('{}');
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [run, setRun] = useState<SequenceRun | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void client.listSequences().then(setSequences).catch(async value => setError(await errorText(value))); }, []);
  useEffect(() => {
    if (!run?.id || run.status !== 'running') return;
    const timer = window.setInterval(() => { void client.getSequenceRun({ id: run.id! }).then(setRun).catch(async value => setError(await errorText(value))); }, 500);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);
  const steps = () => selected ? sequences.find(item => item.id === selected)?.steps || [] : JSON.parse(stepSource) as SequenceStepInput[];
  const prepare = () => {
    const values = parseObject(varsSource);
    const overrides = JSON.parse(stepVarsSource) as Record<string, Record<string, string>>;
    const result = previewSteps(steps(), values, overrides);
    setPreview(result); setError('');
    return { values, overrides };
  };
  return <Card className="panel"><div className="section-title"><h2>定时序列</h2><span className="muted">按步骤角色发送</span></div>
    <label>选择已保存序列<select value={selected} onChange={event => { setSelected(event.target.value); setPreview(null); }}><option value="">新建序列</option>{sequences.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {!selected && <><label>名称<Input value={name} onChange={event => setName(event.target.value)} /></label><label>步骤 JSON<Textarea className="code-input" value={stepSource} onChange={event => { setStepSource(event.target.value); setPreview(null); }} /></label></>}
    <div className="form-columns"><label>vars<Textarea className="code-input" value={varsSource} onChange={event => { setVarsSource(event.target.value); setPreview(null); }} /></label><label>stepVars<Textarea className="code-input" value={stepVarsSource} onChange={event => { setStepVarsSource(event.target.value); setPreview(null); }} /></label></div>
    <div className="actions"><Button className="subtle" onClick={() => { try { prepare(); } catch (value) { setPreview(null); setError(String(value)); } }}>预检</Button><Button onClick={async () => {
      try {
        const { values, overrides } = prepare();
        let sequenceId = selected;
        if (!sequenceId) { const created = await client.createSequence({ sequenceInput: { name, steps: steps() } }); sequenceId = created.id; setSequences(await client.listSequences()); setSelected(sequenceId); }
        const started = await client.startSequence({ id: groupId, startSequence: { sequenceId, vars: values, stepVars: overrides } });
        setRun(await client.getSequenceRun({ id: started.runId }));
      } catch (value) { setError(await errorText(value)); }
    }}>启动</Button></div>
    {error && <p className="error">{error}</p>}
    {preview && <div className="preview"><h3>预检结果</h3>{preview.map(step => <article key={step.index}><strong>第 {step.index} 步 · {step.text}</strong><small>{Object.entries(step.values).map(([key, value]) => `${key}=${value} (${step.sources[key]})`).join('；')}</small></article>)}</div>}
    {run && <div className="preview"><h3>运行 {run.id?.slice(0, 8)} · {run.status}</h3>{run.steps.map((raw, index) => { const step = raw as Record<string, unknown>; return <p key={index}>第 {index + 1} 步 · {String(step.status)} {step.sentAt ? `· ${String(step.sentAt)}` : ''}</p>; })}</div>}
  </Card>;
}
