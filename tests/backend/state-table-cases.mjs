import { strict as assert } from 'node:assert';
import { transitions } from '../../backend/dist/domains/account/state.js';

const statuses = ['idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired'];
const expected = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};
assert.deepEqual(Object.keys(transitions).sort(), [...statuses].sort());
for (const from of statuses) {
  for (const to of statuses) {
    assert.equal(transitions[from].includes(to), expected[from].includes(to), `${from} -> ${to}`);
  }
}
console.log('Account state table cases passed: all 36 transitions, including terminal states and same-state rejection.');
