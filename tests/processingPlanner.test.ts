import { describe, expect, it } from 'vitest';
import { parseLegacyConfigText } from '../src/config/legacyConfigParser';
import type { NormalizedConfig } from '../src/config/legacyTypes';
import {
  createProcessingPlan,
  summarizeProcessingPlan,
} from '../src/runtime/processingPlanner';

const parseConfig = (text: string): NormalizedConfig => {
  const result = parseLegacyConfigText(text);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
  return result.config;
};

describe('processing planner', () => {
  it('splits checks into scheduler-safe chunks by estimated cost', () => {
    const config = parseConfig(`
runs:
  - name: local checks
    checks:
      - name: local regex
        kind: comment
        rules:
          - kind: regex
            criteria:
              - regex: spam
        actions:
          - kind: report
      - name: expensive history
        kind: comment
        rules:
          - kind: history
            window: 7 days
        actions:
          - kind: remove
      - name: delayed followup
        kind: comment
        actions:
          - kind: dispatch
            delay: 10 minutes
`);

    const plan = createProcessingPlan(config, {
      maxCostPerChunk: 6,
      maxChecksPerChunk: 2,
    });

    expect(plan.totalChecks).toBe(3);
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0]?.checks.map((check) => check.checkName)).toEqual([
      'local regex',
    ]);
    expect(plan.chunks[1]?.checks[0]).toMatchObject({
      checkName: 'expensive history',
      costKinds: ['history'],
    });
    expect(plan.chunks[2]?.checks[0]).toMatchObject({
      checkName: 'delayed followup',
      costKinds: ['deferred'],
    });
    expect(plan.chunks[0]?.nextCursor).toEqual({
      runIndex: 0,
      checkIndex: 1,
    });
    expect(summarizeProcessingPlan(plan)).toContain('3 chunk(s)');
  });

  it('ignores disabled runs and checks', () => {
    const config = parseConfig(`
runs:
  - name: disabled run
    enable: false
    checks:
      - name: skipped run check
        kind: comment
  - name: enabled run
    checks:
      - name: disabled check
        kind: comment
        enable: false
      - name: enabled check
        kind: comment
`);

    const plan = createProcessingPlan(config);

    expect(plan.totalChecks).toBe(1);
    expect(plan.chunks[0]?.checks[0]?.checkName).toBe('enabled check');
  });
});
