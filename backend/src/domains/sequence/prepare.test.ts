import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { prepareSteps, SequenceValidationError, validateSequence, type SequenceStep } from './prepare.js';

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

test('stepVars rejects null, unknown steps, and non-string values', () => {
  const vars = { event: 'Demo', time: '10:00', location: 'shared drive' };
  assert.throws(() => prepareSteps(steps, vars, null), error => error instanceof SequenceValidationError && error.code === 'VALIDATION_ERROR');
  assert.throws(() => prepareSteps(steps, vars, { '9': { location: 'x' } }), error => error instanceof SequenceValidationError && error.code === 'VALIDATION_ERROR');
  assert.throws(() => prepareSteps(steps, vars, { '2': { location: 1 } }), error => error instanceof SequenceValidationError && error.code === 'VALIDATION_ERROR');
});

test('sequence sender can be fixed in the template or overridden for one run', () => {
  const withSender: SequenceStep[] = [{ ...steps[0], senderAccountId: 'acc-2' }, steps[1], steps[2]];
  const vars = { event: 'Demo', time: '10:00', location: 'shared drive' };
  assert.equal(prepareSteps(withSender, vars, {})[0].senderAccountId, 'acc-2');
  const overridden = prepareSteps(withSender, vars, {}, { '1': 'acc-1', '2': 'acc-3' });
  assert.equal(overridden[0].senderAccountId, 'acc-1');
  assert.equal(overridden[1].senderAccountId, 'acc-3');
  assert.equal(prepareSteps(withSender, vars, {}, { '1': '' })[0].senderAccountId, undefined);
  assert.equal(withSender[0].senderAccountId, 'acc-2', 'run override does not mutate the saved template');
});

test('specified sender IDs reject malformed values and invalid step indexes', () => {
  const vars = { event: 'Demo', time: '10:00', location: 'shared drive' };
  assert.throws(() => validateSequence([{ ...steps[0], senderAccountId: ' acc-2 ' }]));
  assert.throws(() => prepareSteps(steps, vars, {}, { '4': 'acc-2' }));
  assert.throws(() => prepareSteps(steps, vars, {}, { '01': 'acc-2' }));
  assert.throws(() => prepareSteps(steps, vars, {}, { '1': 3 }));
});
