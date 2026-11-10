import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const platform = join(repo, 'infra/terraform/staging-platform');
const read = (path) => readFileSync(path, 'utf8');

const catalog = JSON.parse(read(join(platform, 'settlement-signals.json')));
const observability = read(join(platform, 'observability.tf'));
const dashboard = read(join(platform, 'observability-dashboard.tf'));
const runbook = read(join(repo, 'docs/runbooks/settlement-observability.md'));
const naming = read(join(platform, 'naming.tf'));
const treasuryRuntime = read(join(platform, 'runtime-treasury-ricardian.tf'));
const { classifyTelemetryField } = createRequire(import.meta.url)(join(repo, 'shared-telemetry'));

const DOMAINS = new Set([
  'transactions',
  'oracle',
  'indexer',
  'reconciliation',
  'treasury',
  'services',
]);
const SEVERITIES = new Set(['critical', 'high']);
const OBSERVED_SERVICES = new Set([
  'gateway',
  'indexer',
  'oracle',
  'reconciliation',
  'relayer',
  'ricardian',
  'treasury',
]);
// Each log group may only be matched against the source that writes to it.
const LOG_GROUP_SOURCES = {
  auth: 'auth/src',
  gateway: 'gateway/src',
  'indexer-pipeline': 'indexer/src',
  oracle: 'oracle/src',
  reconciliation: 'reconciliation/src',
  relayer: 'relayer/src',
  ricardian: 'ricardian/src',
  treasury: 'treasury/src',
};

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'tests' || name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.ts$/u.test(name) && !/\.(test|spec)\.ts$/u.test(name) ? [path] : [];
  });
}

const sourceCache = new Map();
function sourceText(directory) {
  if (!sourceCache.has(directory)) {
    sourceCache.set(
      directory,
      sourceFiles(join(repo, directory))
        .map((file) => read(file))
        .join('\n'),
    );
  }
  return sourceCache.get(directory);
}

function containsLiteral(text, value) {
  return [`'${value}'`, `"${value}"`, `\`${value}\``].some((quoted) => text.includes(quoted));
}

function terraformBlocks(text, type) {
  const blocks = [];
  const pattern = new RegExp(`^resource "${type}" "([^"]+)" \\{\\n([\\s\\S]*?)^\\}`, 'gmu');
  for (const match of text.matchAll(pattern)) blocks.push({ name: match[1], body: match[2] });
  return blocks;
}

test('catalog identifiers, domains, and log groups are well formed', () => {
  const ids = catalog.signals.map((signal) => signal.id);
  assert.equal(new Set(ids).size, ids.length, 'signal ids must be unique');
  const declaredServices = new Set(
    [...naming.matchAll(/^\s+"([a-z-]+)",$/gmu)].map((match) => match[1]),
  );

  for (const signal of catalog.signals) {
    assert.match(signal.id, /^[a-z][a-z0-9_]{2,62}$/u, `${signal.id}: id must be snake_case`);
    assert.ok(DOMAINS.has(signal.domain), `${signal.id}: unknown domain ${signal.domain}`);
    assert.ok(
      declaredServices.has(signal.logGroup) && LOG_GROUP_SOURCES[signal.logGroup],
      `${signal.id}: unknown log group ${signal.logGroup}`,
    );
    assert.deepEqual(
      signal.sourceDirs,
      [LOG_GROUP_SOURCES[signal.logGroup]],
      `${signal.id}: sourceDirs must be the service that writes ${signal.logGroup}`,
    );
    assert.ok(signal.description?.length > 10, `${signal.id}: description is required`);
    assert.ok(signal.conditions.length > 0, `${signal.id}: at least one condition is required`);
  }
});

test('matchers use only public operational telemetry fields', () => {
  for (const signal of catalog.signals) {
    const fields = signal.conditions.map((condition) => condition.field);
    if (signal.valueField) fields.push(signal.valueField);
    for (const field of fields) {
      assert.equal(
        classifyTelemetryField(field),
        'public_operational',
        `${signal.id}: ${field} is not a public operational telemetry field`,
      );
    }
  }
});

test('every matched literal is still emitted by the service source', () => {
  for (const signal of catalog.signals) {
    const text = signal.sourceDirs.map(sourceText).join('\n');
    for (const condition of signal.conditions) {
      assert.ok(condition.equals.length > 0, `${signal.id}: empty condition on ${condition.field}`);
      for (const value of condition.equals) {
        assert.doesNotMatch(value, /["\\]/u, `${signal.id}: values must not need escaping`);
        assert.ok(
          containsLiteral(text, value),
          `${signal.id}: '${value}' no longer appears in ${signal.sourceDirs.join(', ')}; ` +
            'update settlement-signals.json together with the log message',
        );
      }
    }
  }
});

test('alarm definitions are routable and bounded', () => {
  const ingestInterval = Number(
    treasuryRuntime.match(/"TREASURY_INGEST_INTERVAL_MS", value = "(\d+)"/u)?.[1],
  );
  assert.ok(ingestInterval > 0, 'Treasury ingestion interval must be declared');

  for (const signal of catalog.signals) {
    if (signal.valueField) {
      assert.equal(signal.alarm, undefined, `${signal.id}: value signals are dashboard-only`);
      assert.ok(['Seconds', 'None', 'Count'].includes(signal.unit), `${signal.id}: unit`);
    }
    if (!signal.alarm) continue;

    const { kind, severity, periodSeconds = 300, threshold = 1 } = signal.alarm;
    assert.ok(SEVERITIES.has(severity), `${signal.id}: severity must be critical or high`);
    assert.ok(['event', 'heartbeat'].includes(kind), `${signal.id}: unknown alarm kind ${kind}`);
    assert.equal(periodSeconds % 60, 0, `${signal.id}: period must be whole minutes`);
    assert.ok(Number.isInteger(threshold) && threshold >= 1, `${signal.id}: threshold`);

    if (kind === 'heartbeat') {
      assert.ok(OBSERVED_SERVICES.has(signal.alarm.service), `${signal.id}: heartbeat service`);
      const silenceMs = periodSeconds * signal.alarm.evaluationPeriods * 1000;
      assert.ok(
        silenceMs >= 3 * ingestInterval,
        `${signal.id}: heartbeat window must cover at least three ingestion ticks`,
      );
    }
  }
});

test('metric filters never publish dimensions and alarms never hard-code routing', () => {
  for (const { name, body } of terraformBlocks(observability, 'aws_cloudwatch_log_metric_filter')) {
    const transformation = body.match(/metric_transformation \{[\s\S]*?\n {2}\}/u)?.[0];
    assert.ok(transformation, `${name}: metric_transformation is required`);
    assert.doesNotMatch(transformation, /dimensions/u, `${name}: dimensions are prohibited`);
  }

  const alarms = [
    ...terraformBlocks(observability, 'aws_cloudwatch_metric_alarm'),
    ...terraformBlocks(observability, 'aws_cloudwatch_composite_alarm'),
  ];
  assert.ok(alarms.length >= 6, 'expected settlement alarm resources');
  for (const { name, body } of alarms) {
    assert.doesNotMatch(body, /arn:aws:sns/u, `${name}: alarm routing must come from variables`);
    for (const action of body.matchAll(/^\s+(?:alarm_actions|ok_actions)\s+=\s+(.+)$/gmu)) {
      assert.match(
        action[1],
        /^(var\.(critical|high|edge)_alarm_topic_arns|local\.alarm_actions_by_severity\[each\.value\.alarm\.severity\])$/u,
        `${name}: unexpected alarm action source ${action[1]}`,
      );
    }
  }
  assert.doesNotMatch(dashboard, /arn:aws:sns/u);
});

test('dashboard value metrics exist in the catalog', () => {
  const ids = new Set(catalog.signals.map((signal) => signal.id));
  for (const match of dashboard.matchAll(/local\.observability_namespace, "([a-z0-9_]+)"/gu)) {
    assert.ok(ids.has(match[1]), `dashboard references unknown metric ${match[1]}`);
  }
});

test('every alarm has a runbook response', () => {
  const alarmIds = [
    ...catalog.signals.filter((signal) => signal.alarm).map((signal) => signal.id),
    'gateway_slo_fast_burn',
    'gateway_slo_slow_burn',
    'gateway_latency_p99',
    'gateway_readiness_probe',
    'service_running_tasks',
  ];
  for (const id of alarmIds) {
    assert.ok(
      runbook.includes(`\`${id}\``),
      `docs/runbooks/settlement-observability.md has no response for ${id}`,
    );
  }
  assert.ok(runbook.includes('settlement-signals.json'), 'runbook must name the signal catalog');
});
