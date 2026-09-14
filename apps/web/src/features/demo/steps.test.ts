import { describe, expect, it } from 'vitest';

import { formatMinutes } from './format';
import {
  DEMO_STEPS,
  demoStepPath,
  furthestReachableIndex,
  isDemoStepId,
  missingChoiceStep,
  neighbourStep,
  stepIndex,
} from './steps';

describe('demo step guards', () => {
  it('keeps the F-01 order from question to done', () => {
    expect(DEMO_STEPS.map((step) => step.id)).toEqual([
      'question',
      'explanation',
      'probe',
      'result',
      'reflection',
      'observation',
      'done',
    ]);
    expect(neighbourStep('question', -1)).toBeUndefined();
    expect(neighbourStep('done', 1)).toBeUndefined();
    expect(isDemoStepId('admin')).toBe(false);
  });

  it('allows public steps without choices', () => {
    for (const step of ['question', 'explanation', 'probe', 'result'] as const) {
      expect(missingChoiceStep(step, {})).toBeUndefined();
    }
  });

  it('never skips the result or the reflection decision', () => {
    expect(missingChoiceStep('reflection', {})).toBe('result');
    expect(missingChoiceStep('reflection', { resultId: 'same-time' })).toBeUndefined();
    expect(missingChoiceStep('observation', {})).toBe('result');
    expect(missingChoiceStep('done', {})).toBe('result');
    expect(missingChoiceStep('observation', { resultId: 'same-time' })).toBe('reflection');
  });

  it('treats a skipped reflection as a completed decision', () => {
    const skipped = { resultId: 'same-time', reflection: { kind: 'skipped' } } as const;
    expect(missingChoiceStep('observation', skipped)).toBeUndefined();
    expect(missingChoiceStep('done', skipped)).toBeUndefined();
    expect(furthestReachableIndex(skipped)).toBe(stepIndex('done'));
  });

  it('limits rail links by the collected choices', () => {
    expect(furthestReachableIndex({})).toBe(stepIndex('result'));
    expect(furthestReachableIndex({ resultId: 'flat-first' })).toBe(stepIndex('reflection'));
  });

  it('builds URLs without choices or child data', () => {
    expect(demoStepPath('paper-fall', 'observation')).toBe('/demo/paper-fall/observation');
  });
});

describe('formatMinutes', () => {
  it.each([
    [1, '1 минута'],
    [2, '2 минуты'],
    [5, '5 минут'],
    [7, '7 минут'],
    [11, '11 минут'],
    [12, '12 минут'],
    [21, '21 минута'],
    [22, '22 минуты'],
    [30, '30 минут'],
  ])('%i -> %s', (value, expected) => {
    expect(formatMinutes(value)).toBe(expected);
  });
});
