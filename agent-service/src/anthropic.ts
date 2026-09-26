type TurnInput = { runId: string; tools: unknown[]; messages: unknown[] };

export async function anthropicTurn(input: TurnInput): Promise<{ stop_reason: string; content: unknown[] }> {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!key || !model) throw new Error('ANTHROPIC_API_KEY and ANTHROPIC_MODEL are required');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: Math.max(128, Number(process.env.ANTHROPIC_MAX_TOKENS || 512)),
      system: 'You are a group messaging assistant. Respond with exactly one tool call at a time, or one final text block. Use only the four supplied tools. Read recent messages before acting. Respect the policy in the first user message. Finish promptly.',
      tools: input.tools,
      messages: input.messages,
    }),
    signal: AbortSignal.timeout(9000),
  });
  const body = await response.json() as { stop_reason?: string; content?: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(`Anthropic returned ${response.status}: ${body.error?.message || 'unknown error'}`);
  if (body.stop_reason === 'tool_use') {
    const block = body.content?.find(item => item.type === 'tool_use');
    if (!block || typeof block.id !== 'string' || typeof block.name !== 'string') throw new Error('Anthropic tool response is invalid');
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }] };
  }
  if (body.stop_reason === 'end_turn') {
    const text = (body.content || []).filter(item => item.type === 'text').map(item => item.text || '').join('\n');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  }
  throw new Error(`Anthropic stopped with ${body.stop_reason || 'unknown reason'}`);
}
