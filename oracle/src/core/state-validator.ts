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
      case TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD:
      case TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL:
        this.validateConfirmArrival(trade);
        break;

      case TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE:
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

    if (!trade.arrivalTimestamp) {
      throw new ValidationError(`Cannot finalize: Trade ${trade.tradeId} has no arrival timestamp`);
    }

    // The contract owns the per-trade 48h/72h deadline and the separate
    // immediate path for explicit buyer acceptance.
  }

  static validateTradeId(tradeId: string): void {
    if (!/^\d+$/.test(tradeId)) {
      throw new ValidationError(`Invalid trade ID format: ${tradeId}`);
    }
  }
}
