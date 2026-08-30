/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { startGatewayBackgroundRuntimes } from '../src/core/gatewayBackgroundRuntimes';

describe('gateway background runtime lifecycle', () => {
  test('starts and stops each configured runtime once in declaration order', () => {
    const events: string[] = [];
    const first = {
      start: () => events.push('first:start'),
      stop: () => events.push('first:stop'),
    };
    const second = {
      start: () => events.push('second:start'),
      stop: () => events.push('second:stop'),
    };

    const stop = startGatewayBackgroundRuntimes([first, null, second]);
    stop();

    expect(events).toEqual(['first:start', 'second:start', 'first:stop', 'second:stop']);
  });
});
