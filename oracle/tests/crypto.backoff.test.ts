import { calculateBackoff } from '../src/utils/crypto';

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
