export type SequenceStep = { index: number; accountRole: 'admin' | 'member'; text: string; delaySeconds: number; senderAccountId?: string };
export type PreparedStep = SequenceStep & { status: 'pending'; scheduledAt: string | null; sentAt: string | null; clientMsgId: string | null; resolvedVars: Record<string, string>; varSources: Record<string, string> };
export class SequenceValidationError extends Error {
  constructor(public readonly code: 'VALIDATION_ERROR' | 'UNRESOLVED_PLACEHOLDER', message: string, public readonly stepIndex?: number, public readonly key?: string) { super(message); }
}
export function validateSequence(steps: unknown): asserts steps is SequenceStep[] {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new SequenceValidationError('VALIDATION_ERROR', '序列必须包含 1 至 100 个步骤');
  for (const [position, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || step.index !== position + 1 || !['admin', 'member'].includes(step.accountRole) || typeof step.text !== 'string' || !step.text.trim() || typeof step.delaySeconds !== 'number' || !Number.isFinite(step.delaySeconds) || step.delaySeconds < 0 || (step.senderAccountId !== undefined && (typeof step.senderAccountId !== 'string' || step.senderAccountId.length > 128 || (step.senderAccountId !== '' && step.senderAccountId.trim() !== step.senderAccountId)))) {
      throw new SequenceValidationError('VALIDATION_ERROR', `第 ${position + 1} 步格式错误`);
    }
  }
}
function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SequenceValidationError('VALIDATION_ERROR', '变量必须是对象');
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !/^[A-Za-z0-9_]+$/.test(key) || typeof item !== 'string')) throw new SequenceValidationError('VALIDATION_ERROR', '变量名或变量值不合法');
  return Object.fromEntries(entries) as Record<string, string>;
}

function stepRecords(value: unknown, stepCount: number): Record<string, Record<string, string>> {
  if (value === undefined) return {};
  if (value === null) throw new SequenceValidationError('VALIDATION_ERROR', 'stepVars 必须是对象');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SequenceValidationError('VALIDATION_ERROR', 'stepVars 必须是对象');
  const result: Record<string, Record<string, string>> = {};
  for (const [stepKey, raw] of Object.entries(value)) {
    if (!/^\d+$/.test(stepKey) || Number(stepKey) < 1 || Number(stepKey) > stepCount) {
      throw new SequenceValidationError('VALIDATION_ERROR', `stepVars 包含无效步骤 ${stepKey}`);
    }
    result[stepKey] = record(raw);
  }
  return result;
}
function senderRecords(value: unknown, stepCount: number): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SequenceValidationError('VALIDATION_ERROR', 'stepAccountIds 必须是对象');
  const result: Record<string, string> = {};
  for (const [stepKey, raw] of Object.entries(value)) {
    if (!/^\d+$/.test(stepKey) || String(Number(stepKey)) !== stepKey || Number(stepKey) < 1 || Number(stepKey) > stepCount || typeof raw !== 'string' || raw.length > 128 || raw.trim() !== raw) {
      throw new SequenceValidationError('VALIDATION_ERROR', `第 ${stepKey} 步指定发送账号无效`);
    }
    result[stepKey] = raw;
  }
  return result;
}
export function prepareSteps(steps: SequenceStep[], vars: unknown, stepVars: unknown, stepAccountIds?: unknown): PreparedStep[] {
  validateSequence(steps);
  const defaults = vars === undefined || vars === null ? {} : record(vars);
  const overrides = stepRecords(stepVars, steps.length);
  const senders = senderRecords(stepAccountIds, steps.length);
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) if (value !== '') { values[key] = value; sources[key] = 'default'; }
  const startedAt = Date.now();
  return steps.map(step => {
    for (const [key, value] of Object.entries(overrides[String(step.index)] || {})) if (value !== '') { values[key] = value; sources[key] = `step:${step.index}`; }
    const missing = [...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).find(key => values[key] === undefined);
    if (missing) throw new SequenceValidationError('UNRESOLVED_PLACEHOLDER', '缺少占位符', step.index, missing);
    const text = step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key]);
    const senderAccountId = Object.hasOwn(senders, String(step.index)) ? senders[String(step.index)] : step.senderAccountId;
    return { ...step, senderAccountId: senderAccountId || undefined, text, status: 'pending', scheduledAt: step.index === 1 ? new Date(startedAt + step.delaySeconds * 1000).toISOString() : null, sentAt: null, clientMsgId: null, resolvedVars: { ...values }, varSources: { ...sources } };
  });
}
