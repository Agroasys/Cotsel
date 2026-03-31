export interface OrderedEvmEvent {
  id: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
}

export function buildEvmEventId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

export function compareOrderedEvmEvents(left: OrderedEvmEvent, right: OrderedEvmEvent): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber;
  }

  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }

  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
  }

  return left.id.localeCompare(right.id);
}
