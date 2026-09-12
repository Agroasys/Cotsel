import { closeConnection } from './database/connection';
import {
  getContainment,
  listBlockingContainments,
  releaseContainment,
} from './database/containments';
import type { TradeContainmentRow } from './types';

/**
 * Operator surface for the PRES-11 scoped containment control.
 *
 * `release` is deliberately a human action carrying a governed approval
 * reference: reconciliation can prove a trade reconciles clean, but it has no
 * authority to decide the trade may settle again. The escrow's own unpause
 * proposal remains the on-chain half of that decision.
 */
type Command = 'list' | 'show' | 'release';

interface CliArgs {
  command: Command;
  tradeId?: string;
  approvalReference?: string;
}

const USAGE =
  'Usage: ts-node src/containment-cli.ts <list|show|release> ' +
  '[--trade-id=<value>] [--approval-ref=<value>]';

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
  const approvalReference = flag(argv, 'approval-ref');

  if ((command === 'show' || command === 'release') && !tradeId) {
    throw new Error(`--trade-id is required for "${command}". ${USAGE}`);
  }

  if (command === 'release' && !approvalReference) {
    throw new Error(
      'A governed approval reference is required to release a contained trade. ' +
        'Record the quorum decision and pass it as --approval-ref=<value>.',
    );
  }

  return { command, tradeId, approvalReference };
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
    clearedRunKey: row.cleared_run_key,
    clearedAt: row.cleared_at?.toISOString() ?? null,
    approvalReference: row.approval_reference,
    releasedAt: row.released_at?.toISOString() ?? null,
  };
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

    const released = await releaseContainment({
      tradeId: args.tradeId as string,
      approvalReference: args.approvalReference as string,
    });

    if (!released) {
      const current = await getContainment(args.tradeId as string);
      throw new Error(
        current
          ? `Trade ${args.tradeId} is ${current.state}; only a trade that has reconciled clean ` +
              '(RECONCILED_PENDING_APPROVAL) can be released. Run a fresh reconciliation first.'
          : `No containment recorded for trade ${args.tradeId}`,
      );
    }

    process.stdout.write(JSON.stringify(render(released), null, 2) + '\n');
  } finally {
    await closeConnection();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
