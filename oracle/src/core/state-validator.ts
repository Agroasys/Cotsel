import { Trade, TradeStatus } from '@agroasys/sdk';
import { TriggerType } from '../types/trigger';
import { ValidationError } from '../utils/errors';
import { Logger } from '../utils/logger';

export class StateValidator {
  static validateTradeState(trade: Trade, triggerType: TriggerType): void {
    Logger.info('Validating trade state', {
      tradeId: trade.tradeId,
      currentStatus: trade.status,
      triggerType,
    });

    switch (triggerType) {
      case TriggerType.RELEASE_STAGE_1:
        this.validateReleaseStage1(trade);
        break;

      case TriggerType.CONFIRM_ARRIVAL:
        this.validateConfirmArrival(trade);
        break;

      case TriggerType.FINALIZE_TRADE:
        this.validateFinalizeTrade(trade);
        break;

      default:
        throw new ValidationError(`Unknown trigger type: ${triggerType}`);
    }

    Logger.info('Trade state validation passed', {
      tradeId: trade.tradeId,
      triggerType,
    });
  }

  private static validateReleaseStage1(trade: Trade): void {
    if (trade.status !== TradeStatus.LOCKED) {
      throw new ValidationError(
        `Cannot release stage 1: Trade ${trade.tradeId} is in status ${TradeStatus[trade.status]}, expected LOCKED`,
      );
    }
  }

  private static validateConfirmArrival(trade: Trade): void {
    if (trade.status !== TradeStatus.IN_TRANSIT) {
      throw new ValidationError(
        `Cannot confirm arrival: Trade ${trade.tradeId} is in status ${TradeStatus[trade.status]}, expected IN_TRANSIT`,
      );
    }
  }

  private static validateFinalizeTrade(trade: Trade): void {
    if (trade.status !== TradeStatus.ARRIVAL_CONFIRMED) {
      throw new ValidationError(
        `Cannot finalize: Trade ${trade.tradeId} is in status ${TradeStatus[trade.status]}, expected ARRIVAL_CONFIRMED`,
      );
    }

    if (trade.arrivalTimestamp) {
      const DISPUTE_WINDOW_HOURS = 24;
      const disputeWindowMs = DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
      const arrivalTime = trade.arrivalTimestamp.getTime();
      const now = Date.now();

      if (now <= arrivalTime + disputeWindowMs) {
        const remainingMs = arrivalTime + disputeWindowMs - now;
        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
        const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));

        throw new ValidationError(
          `Cannot finalize: Dispute window (24h) not expired. Remaining: ${remainingHours}h (${remainingMinutes} minutes)`,
        );
      }

      Logger.info('Dispute window validation passed', {
        tradeId: trade.tradeId,
        arrivalTimestamp: trade.arrivalTimestamp.toISOString(),
        elapsedHours: ((now - arrivalTime) / (60 * 60 * 1000)).toFixed(2),
      });
    } else {
      throw new ValidationError(`Cannot finalize: Trade ${trade.tradeId} has no arrival timestamp`);
    }
  }

  static validateTradeId(tradeId: string): void {
    if (!/^\d+$/.test(tradeId)) {
      throw new ValidationError(`Invalid trade ID format: ${tradeId}`);
    }
  }
}
