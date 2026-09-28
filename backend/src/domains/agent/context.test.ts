import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecentAgentMessages } from './context.js';

const message = (msgId: string, sentAt: string, text = msgId) => ({
  msgId,
  senderPlatformUserId: 'user-1',
  isOwn: false,
  text,
  sentAt,
});

test('retains the original trigger when newer messages exceed the requested window', () => {
  const result = buildRecentAgentMessages({
    triggerMessages: [message('trigger', '2026-09-27T00:00:00.000Z')],
    recentMessages: Array.from({ length: 50 }, (_, index) => message(`new-${index}`, `2026-09-27T00:${String(index + 1).padStart(2, '0')}:00.000Z`)),
    limit: 10,
  });
  assert.equal(result.messages[0].msgId, 'trigger');
  assert.equal(result.messages.length, 10);
  assert.equal(result.truncated, true);
});

test('merges trigger and in-run messages without duplicates and sorts chronologically', () => {
  const result = buildRecentAgentMessages({
    triggerMessages: [message('trigger', '2026-09-27T00:02:00.000Z')],
    recentMessages: [message('newer', '2026-09-27T00:03:00.000Z'), message('trigger', '2026-09-27T00:02:00.000Z')],
    limit: 50,
  });
  assert.deepEqual(result.messages.map(item => item.msgId), ['trigger', 'newer']);
  assert.equal(result.truncated, false);
});

test('caps message text at 500 characters and marks the response truncated', () => {
  const result = buildRecentAgentMessages({
    triggerMessages: [message('trigger', '2026-09-27T00:00:00.000Z', 'x'.repeat(700))],
    recentMessages: [],
    limit: 50,
  });
  assert.equal(result.messages[0].text.length, 500);
  assert.equal(result.truncated, true);
});
