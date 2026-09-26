import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { prepareSteps, SequenceValidationError, validateSequence } from './prepare.js';

const steps = [
  { index: 1, accountRole: 'admin' as const, text: '{event} at {time}', delaySeconds: 0 },
  { index: 2, accountRole: 'member' as const, text: '{event} in {location}', delaySeconds: 5 },
  { index: 3, accountRole: 'admin' as const, text: '{location}', delaySeconds: 0 },
];

test('sequence variables inherit overrides and preserve their source', () => {
  const result = prepareSteps(steps, { event: 'Demo', time: '10:00', location: 'old' }, { '2': { event: '', location: 'shared drive' } });
  assert.equal(result[0].text, 'Demo at 10:00');
  assert.equal(result[1].text, 'Demo in shared drive');
  assert.equal(result[2].varSources.location, 'step:2');
  assert.equal(result[2].resolvedVars.location, 'shared drive');
});

test('missing placeholder identifies the one-based step and key', () => {
  assert.throws(() => prepareSteps(steps, { event: 'Demo', time: '10:00' }, {}), (error: unknown) => {
    assert(error instanceof SequenceValidationError);
    assert.equal(error.code, 'UNRESOLVED_PLACEHOLDER');
    assert.equal(error.stepIndex, 2);
    assert.equal(error.key, 'location');
    return true;
  });
});

test('sequence structure rejects missing or reordered indexes', () => {
  assert.throws(() => validateSequence([{ ...steps[0], index: 2 }]));
  assert.throws(() => validateSequence([{ ...steps[0], delaySeconds: -1 }]));
});
