/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Request, Response } from 'express';
import { OracleController } from '../src/api/controller';
import { TriggerStatus } from '../src/types/trigger';
import type { OracleResponse, ErrorResponse } from '../src/types';

jest.mock('../src/database/queries', () => ({ listTriggers: jest.fn() }));

function responseRecorder() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json };
}

function triggerResult(status: TriggerStatus) {
  return {
    idempotencyKey: 'FINAL_RELEASE:request-42',
    actionKey: 'FINAL_RELEASE:42',
    status,
    idempotent: false,
    message: `result: ${status}`,
  };
}

describe('OracleController execution truth', () => {
  it.each([
    [TriggerStatus.TERMINAL_FAILURE, 422],
    [TriggerStatus.EXHAUSTED_NEEDS_REDRIVE, 503],
  ])('reports %s as a failed command', async (executionStatus, expectedHttpStatus) => {
    const triggerManager = {
      executeTrigger: jest.fn().mockResolvedValue(triggerResult(executionStatus)),
    };
    const controller = new OracleController(triggerManager as never);
    const recorder = responseRecorder();

    await controller.finalizeTrade(
      { body: { tradeId: '42', requestId: 'request-42' } } as Request,
      recorder as unknown as Response<OracleResponse | ErrorResponse>,
    );

    expect(recorder.status).toHaveBeenCalledWith(expectedHttpStatus);
    expect(recorder.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, status: executionStatus }),
    );
  });

  it.each([TriggerStatus.SUBMITTED, TriggerStatus.CONFIRMED])(
    'reports %s as an accepted command',
    async (executionStatus) => {
      const triggerManager = {
        executeTrigger: jest.fn().mockResolvedValue(triggerResult(executionStatus)),
      };
      const controller = new OracleController(triggerManager as never);
      const recorder = responseRecorder();

      await controller.finalizeTrade(
        { body: { tradeId: '42', requestId: 'request-42' } } as Request,
        recorder as unknown as Response<OracleResponse | ErrorResponse>,
      );

      expect(recorder.status).toHaveBeenCalledWith(200);
      expect(recorder.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, status: executionStatus }),
      );
    },
  );
});
