import { describe, expect, it } from 'vitest';
import { validateContextModConfigText } from '../src/config/configValidation';
import { commentParentModifierFixture } from '../src/runtime/playtestFixtures';

describe('validateContextModConfigText', () => {
  it('accepts a valid ContextMod YAML config against the bundled App schema', () => {
    const result = validateContextModConfigText(
      commentParentModifierFixture.configText,
      { sourceName: 'fixture' }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.format).toBe('yaml');
    expect(result.schemaErrors).toEqual([]);
  });

  it('rejects YAML that is schema-shaped but not a ContextMod config', () => {
    const result = validateContextModConfigText('anything: goes');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Config must define either "runs", "checks"');
  });

  it('rejects configs that parse but fail the bundled JSON schema', () => {
    const result = validateContextModConfigText(`
checks:
  - name: valid check
    kind: comment
    rules:
      - kind: regex
        criteria:
          - regex: '/spam/i'
dryRun: nope
`);

    expect(result.ok).toBe(false);
    expect(result.schemaErrors.some((error) => error.includes('dryRun'))).toBe(true);
  });
});
