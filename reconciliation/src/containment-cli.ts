import { closeConnection } from './database/connection';
import { EscrowGovernanceReader } from './blockchain/escrowGovernance';
import {
  ReplayedApprovalError,
  getContainment,
  listBlockingContainments,
  releaseContainment,
} from './database/containments';
import {
  GovernedApprovalError,
  evaluateGovernedUnpause,
  normalizeTxHash,
} from './core/governedApproval';
import type { TradeContainmentRow } from './types';

/**
 * Operator surface for the PRES-11 scoped containment control.
 *
 * `release` is deliberately a human action, but not a matter of assertion: it
 * names the governed unpause transaction and this reads that transaction back
 * from the chain. Reconciliation can prove a trade reconciles clean; only the
 * escrow's own quorum can decide it may settle again, and the receipt of that
 * decision is what gets recorded here.
 */
type Command = 'list' | 'show' | 'release';

interface CliArgs {
  command: Command;
  tradeId?: string;
  approvalTxHash?: string;
}

const USAGE =
  'Usage: ts-node src/containment-cli.ts <list|show|release> ' +
  '[--trade-id=<value>] [--approval-tx=<0x…>]';

function flag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[2] as Command | undefined;

  if (command !== 'list' && command !== 'show' && command !== 'release') {
    throw new Error(USAGE);
  }

  const tradeId = flag(argv, 'trade-id');
  const approvalTx = flag(argv, 'approval-tx');

  if ((command === 'show' || command === 'release') && !tradeId) {
    throw new Error(`--trade-id is required for "${command}". ${USAGE}`);
  }

  if (command === 'release' && !approvalTx) {
    throw new Error(
      'A governed unpause transaction is required to release a contained trade. Execute the ' +
        'escrow unpause proposal for this trade to quorum and pass its transaction hash as ' +
        '--approval-tx=<0x…>.',
    );
  }

  return {
    command,
    tradeId,
    approvalTxHash: approvalTx ? normalizeTxHash(approvalTx) : undefined,
  };
}

function render(row: TradeContainmentRow): Record<string, unknown> {
  return {
    tradeId: row.trade_id,
    incidentReference: row.incident_reference,
    state: row.state,
    qualifyingCodes: row.qualifying_codes,
    openedRunKey: row.opened_run_key,
    openedAt: row.opened_at.toISOString(),
    observationCount: row.observation_count,
    lastObservedRunKey: row.last_observed_run_key,
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    onchainPauseObservedAt: row.pause_observed_at?.toISOString() ?? null,
    onchainPauseObservedBlock: row.pause_observed_block,
    onchainPauseLastCheckedAt: row.pause_last_checked_at?.toISOString() ?? null,
    clearedRunKey: row.cleared_run_key,
    clearedAt: row.cleared_at?.toISOString() ?? null,
    approval: row.approval_tx_hash
      ? {
          txHash: row.approval_tx_hash,
          chainId: row.approval_chain_id,
          contract: row.approval_contract,
          blockNumber: row.approval_block_number,
          blockHash: row.approval_block_hash,
          logIndex: row.approval_log_index,
          incidentRef: row.approval_incident_ref,
          approvers: row.approval_approvers,
          approvalCount: row.approval_count,
          requiredApprovals: row.approval_required,
          approvedAt: row.approved_at?.toISOString() ?? null,
        }
      : null,
    releasedAt: row.released_at?.toISOString() ?? null,
  };
}

/**
 * Read the named transaction back from the chain and refuse it unless it is the
 * governed unpause for *this* incident.
 *
 * Ordered so the failure an operator is most likely to hit — naming a trade
 * that is not waiting on approval — is reported before any RPC work.
 */
async function release(tradeId: string, approvalTxHash: string): Promise<TradeContainmentRow> {
  const current = await getContainment(tradeId);
  if (!current) {
    throw new Error(`No containment recorded for trade ${tradeId}`);
  }

  if (current.state !== 'RECONCILED_PENDING_APPROVAL') {
    throw new Error(
      `Trade ${tradeId} is ${current.state}; only a trade that has reconciled clean ` +
        '(RECONCILED_PENDING_APPROVAL) can be released. Run a fresh reconciliation first.',
    );
  }

  if (!current.pause_observed_at) {
    throw new Error(
      `Trade ${tradeId} has never been observed paused on chain, so there is no containment for a ` +
        'governed unpause to lift. Confirm the scoped pause was applied and let a reconciliation ' +
        'run record it before releasing.',
    );
  }

  const reader = new EscrowGovernanceReader();
  const evidence = evaluateGovernedUnpause(await reader.readGovernedUnpause(approvalTxHash), {
    tradeId,
    incidentReference: current.incident_reference,
    openedAt: current.opened_at,
  });

  const released = await releaseContainment({ tradeId, evidence });
  if (!released) {
    // The row moved between the checks above and the write — a fresh divergence
    // reopened the incident, or another operator released it first.
    throw new Error(
      `Trade ${tradeId} changed state while its release was being verified; re-run "show" and ` +
        'start again.',
    );
  }

  return released;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  try {
    if (args.command === 'list') {
      const blocking = await listBlockingContainments();
      process.stdout.write(
        JSON.stringify(
          { blockingCount: blocking.length, containments: blocking.map(render) },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    if (args.command === 'show') {
      const row = await getContainment(args.tradeId as string);
      if (!row) {
        throw new Error(`No containment recorded for trade ${args.tradeId}`);
      }
      process.stdout.write(JSON.stringify(render(row), null, 2) + '\n');
      return;
    }

    const released = await release(args.tradeId as string, args.approvalTxHash as string);
    process.stdout.write(JSON.stringify(render(released), null, 2) + '\n');
  } finally {
    await closeConnection();
  }
}

main().catch((error: unknown) => {
  if (error instanceof GovernedApprovalError || error instanceof ReplayedApprovalError) {
    console.error(`REFUSED: ${error.message}`);
    process.exit(2);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
