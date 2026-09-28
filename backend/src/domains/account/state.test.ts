import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isTerminal, transitions } from './state.js';

test('account state table has no terminal exits and no self transitions', () => {
  for (const [from, targets] of Object.entries(transitions)) {
    assert(!targets.includes(from as never));
    if (isTerminal(from)) assert.equal(targets.length, 0);
  }
  assert(transitions.online.includes('rate_limited'));
  assert(transitions.idle.includes('online'));
  assert(transitions.rate_limited.includes('online'));
});
