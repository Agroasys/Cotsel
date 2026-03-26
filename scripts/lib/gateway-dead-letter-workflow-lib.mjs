export function parseGatewayDeadLetterArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error('usage: node scripts/gateway-dead-letter-workflow.mjs <list|replay> [options]');
  }

  let json = false;
  let state = 'open';
  let all = false;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--all') {
      all = true;
      continue;
    }

    if (arg === '--state') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('--state requires a value');
      }
      state = value;
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  if (command === 'list') {
    return {
      command,
      json,
      state: all ? null : state,
    };
  }

  if (command === 'replay') {
    const failedOperationId = positional[0];
    if (!failedOperationId) {
      throw new Error('replay requires <failedOperationId>');
    }

    return {
      command,
      json,
      failedOperationId,
    };
  }

  throw new Error(`unsupported command: ${command}`);
}

function formatRecord(record) {
  return [
    record.failedOperationId,
    record.failureState,
    record.operationType,
    record.targetService,
    record.retryCount,
    record.lastFailedAt,
  ].join('\t');
}

export async function runGatewayDeadLetterWorkflow(argv, deps, io = console) {
  const parsed = parseGatewayDeadLetterArgs(argv);

  if (parsed.command === 'list') {
    const records = await deps.listFailedOperations(parsed.state ? { failureState: parsed.state } : {});
    if (parsed.json) {
      io.log(JSON.stringify({ success: true, data: records }, null, 2));
      return { success: true, data: records };
    }

    io.log('failedOperationId\tfailureState\toperationType\ttargetService\tretryCount\tlastFailedAt');
    for (const record of records) {
      io.log(formatRecord(record));
    }
    return { success: true, data: records };
  }

  const record = await deps.replayFailedOperation(parsed.failedOperationId);
  if (parsed.json) {
    io.log(JSON.stringify({ success: true, data: record }, null, 2));
    return { success: true, data: record };
  }

  io.log(`replayed\t${record.failedOperationId}\t${record.failureState}\t${record.lastReplayedAt ?? 'n/a'}`);
  return { success: true, data: record };
}

