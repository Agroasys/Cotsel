import { calculateBackoff, generateActionKey } from '../src/utils/crypto';

describe('calculateBackoff', () => {
  const originalRandom = Math.random;

  afterEach(() => {
    Math.random = originalRandom;
  });

  test('caps exponential backoff at maxDelayMs', () => {
    Math.random = () => 0.99;

    const backoff = calculateBackoff(6, 1000, 3000, 500);

    expect(backoff).toBeLessThanOrEqual(3000);
    expect(backoff).toBeGreaterThanOrEqual(1000);
  });

  test('returns deterministic floor when jitter budget is zero', () => {
    Math.random = () => 0.5;

    const backoff = calculateBackoff(1, 3000, 3000, 500);

    expect(backoff).toBe(3000);
  });
});

describe('generateActionKey', () => {
  test('treats inspection acceptance and notice expiry as the same final-release action', () => {
    expect(generateActionKey('FINALIZE_AFTER_INSPECTION_ACCEPTANCE', '42')).toBe(
      'FINAL_RELEASE:42',
    );
    expect(generateActionKey('FINALIZE_TRADE', '42')).toBe('FINAL_RELEASE:42');
  });

  test('preserves distinct action identities for non-final settlement transitions', () => {
    expect(generateActionKey('RELEASE_STAGE_1', '42')).toBe('RELEASE_STAGE_1:42');
  });
});
