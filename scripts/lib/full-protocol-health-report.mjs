import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROFILE = 'runtime';
export const DEFAULT_REPORT_PATH = 'reports/full-protocol-health/latest.json';
export const REQUIRED_SERVICE_NAMES = [
  'auth',
  'gateway',
  'oracle',
  'reconciliation',
  'ricardian',
  'treasury',
  'notifications',
  'indexer-pipeline',
  'indexer-graphql',
  'postgres',
  'redis',
];

const ROUTED_AUTH_SUFFIX = '/api/auth/v1';
const ROUTED_GATEWAY_SUFFIX = '/api/dashboard-gateway/v1';
const DEFAULT_BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export function parseEnvContent(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = rawLine.indexOf('=');
    const key = rawLine.slice(0, index).trim();
    let value = rawLine.slice(index + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvContent(fs.readFileSync(filePath, 'utf8'));
}

export function loadProfileEnv(rootDir, profile = DEFAULT_PROFILE) {
  const runtimePath = path.join(rootDir, '.env.runtime');
  if (fs.existsSync(runtimePath)) {
    return {
      source: '.env.runtime',
      values: {
        ...readEnvFile(runtimePath),
        ...process.env,
      },
    };
  }

  const profileFile = '.env.runtime';
  return {
    source: profileFile,
    values: {
      ...readEnvFile(path.join(rootDir, '.env')),
      ...readEnvFile(path.join(rootDir, profileFile)),
      ...process.env,
    },
  };
}

export function normalizeUrl(value, suffix) {
  if (!value) return null;
  const trimmed = String(value).trim().replace(/\/+$/, '');
  if (!suffix || trimmed.endsWith(suffix)) return trimmed;
  return `${trimmed}${suffix}`;
}

export function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? '').trim());
}

export function sameAddress(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

export function latestDeployReport(rootDir, runtimeKey = 'base-sepolia') {
  const reportPath = path.join(
    rootDir,
    'contracts',
    'reports',
    'deploy',
    runtimeKey,
    'agroasysescrow-deploy.json',
  );
  if (!fs.existsSync(reportPath)) return null;
  try {
    return {
      path: path.relative(rootDir, reportPath),
      data: JSON.parse(fs.readFileSync(reportPath, 'utf8')),
    };
  } catch {
    return null;
  }
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value ?? ''));
}

function isTransactionHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value ?? ''));
}

export function validateCandidateDeployReport(data) {
  const failures = [];
  const contract = data?.contract ?? {};
  const args = contract.constructorArguments ?? {};
  const attestation = contract.roleAttestation ?? {};
  const artifact = data?.artifact ?? {};
  const verification = data?.verification ?? {};

  if (!/^[0-9a-f]{40}$/.test(String(data?.commitSha ?? '')) || data?.worktreeClean !== true) {
    failures.push('source_identity');
  }
  if (!Number.isSafeInteger(contract.deploymentBlock) || contract.deploymentBlock < 0) {
    failures.push('deployment_block');
  }
  if (contract.deploymentReceiptStatus !== 1 || !isTransactionHash(contract.deploymentTxHash)) {
    failures.push('deployment_receipt');
  }
  if (
    verification.requested !== true ||
    !['verified', 'already-verified'].includes(verification.status)
  ) {
    failures.push('explorer_verification');
  }
  if (
    !isSha256(artifact.abiSha256) ||
    !isSha256(artifact.bytecodeSha256) ||
    !isSha256(artifact.localRuntimeBytecodeSha256) ||
    !isSha256(artifact.liveRuntimeBytecodeSha256) ||
    !isSha256(artifact.normalizedLocalRuntimeBytecodeSha256) ||
    !isSha256(artifact.normalizedRuntimeBytecodeSha256) ||
    !isSha256(artifact.compilerInputSha256) ||
    artifact.runtimeBytecodeMatches !== true ||
    artifact.normalizedLocalRuntimeBytecodeSha256 !== artifact.normalizedRuntimeBytecodeSha256 ||
    !artifact.compilerLongVersion ||
    !artifact.compilerSettings ||
    !artifact.sourceSha256 ||
    Object.keys(artifact.sourceSha256 ?? {}).length === 0 ||
    Object.values(artifact.sourceSha256).some((value) => !isSha256(value))
  ) {
    failures.push('artifact_provenance');
  }

  const admins = Array.isArray(args.admins) ? args.admins : [];
  const roleAddresses = [
    args.oracleAddress,
    args.treasuryAddress,
    args.relayerAddress,
    ...admins,
    contract.deployerAddress,
  ];
  const normalizedRoles = roleAddresses.filter(isEvmAddress).map((value) => value.toLowerCase());
  const rolesAreDistinct =
    roleAddresses.length === normalizedRoles.length &&
    new Set(normalizedRoles).size === normalizedRoles.length;
  const attestedAdmins = Array.isArray(attestation.admins) ? attestation.admins : [];
  const attestationMatches =
    sameAddress(attestation.usdcAddress, args.usdcAddress) &&
    sameAddress(attestation.oracleAddress, args.oracleAddress) &&
    sameAddress(attestation.treasuryAddress, args.treasuryAddress) &&
    sameAddress(attestation.treasuryPayoutAddress, args.treasuryAddress) &&
    attestation.relayerAllowed === true &&
    attestation.requiredApprovals === args.requiredApprovals &&
    attestation.governanceEpoch === 1 &&
    attestation.oracleActive === true &&
    attestedAdmins.length === admins.length &&
    attestedAdmins.every((admin, index) => sameAddress(admin, admins[index]));
  if (!rolesAreDistinct || !attestationMatches) {
    failures.push('role_attestation');
  }

  return { ok: failures.length === 0, failures };
}

function reportCheck(checks, name, ok, details = {}) {
  checks.push({
    name,
    status: ok ? 'pass' : 'fail',
    ...details,
  });
}

function uniquePresent(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).toLowerCase()))];
}

function redactSensitiveOutput(value) {
  return String(value || '')
    .replace(
      /(PRIVATE_KEY|SECRET|PASSWORD|API_KEY|API_KEYS_JSON|HMAC_SECRET|JWT_SECRET|DATABASE_URL|RPC_URL|RPC_ENDPOINT|WEBHOOK_SIGNING_SECRET|ENCRYPTION_KEY)(\s*[:=]\s*)([^\s]+)/g,
      '$1$2[REDACTED]',
    )
    .replace(
      /(https:\/\/api\.developer\.coinbase\.com\/rpc\/v1\/base-sepolia\/)[A-Za-z0-9_-]+/g,
      '$1[REDACTED]',
    )
    .replace(
      /(https:\/\/base-sepolia\.g\.alchemy\.com\/v2\/)[A-Za-z0-9_-]+/g,
      '$1[REDACTED]',
    )
    .replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED_PRIVATE_KEY]');
}

function runCommand(rootDir, command, args, timeoutMs) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    signal: result.signal,
    startedAt,
    finishedAt: new Date().toISOString(),
    stdout: redactSensitiveOutput(result.stdout).slice(-12000),
    stderr: redactSensitiveOutput(result.stderr).slice(-12000),
    error: result.error ? result.error.message : null,
  };
}

export function buildStaticProtocolReport({
  rootDir,
  profile = DEFAULT_PROFILE,
  mode = 'config-only',
  sessionFile = null,
  now = new Date(),
}) {
  const env = loadProfileEnv(rootDir, profile);
  const values = env.values;
  const deployReport = latestDeployReport(rootDir, 'base-sepolia');
  const checks = [];

  const chainId = values.STAGING_E2E_REAL_CHAIN_ID || values.GATEWAY_CHAIN_ID || values.CHAIN_ID;
  const runtime =
    values.GATEWAY_SETTLEMENT_RUNTIME ||
    values.ORACLE_SETTLEMENT_RUNTIME ||
    values.RECONCILIATION_SETTLEMENT_RUNTIME ||
    null;
  const networkName = values.STAGING_E2E_REAL_NETWORK_NAME || null;
  const escrowAddresses = {
    gateway: values.GATEWAY_ESCROW_ADDRESS || null,
    oracle: values.ORACLE_ESCROW_ADDRESS || null,
    reconciliation: values.RECONCILIATION_ESCROW_ADDRESS || null,
    indexer: values.INDEXER_CONTRACT_ADDRESS || null,
  };
  const usdcAddresses = {
    gateway: values.GATEWAY_USDC_ADDRESS || null,
    oracle: values.ORACLE_USDC_ADDRESS || null,
    reconciliation: values.RECONCILIATION_USDC_ADDRESS || null,
  };
  const canonicalEscrowAddress =
    values.GATEWAY_ESCROW_ADDRESS ||
    values.ORACLE_ESCROW_ADDRESS ||
    values.RECONCILIATION_ESCROW_ADDRESS ||
    values.INDEXER_CONTRACT_ADDRESS ||
    null;
  const canonicalUsdcAddress =
    values.GATEWAY_USDC_ADDRESS ||
    values.ORACLE_USDC_ADDRESS ||
    values.RECONCILIATION_USDC_ADDRESS ||
    DEFAULT_BASE_SEPOLIA_USDC;

  reportCheck(checks, 'profile_is_runtime', profile === 'runtime', {
    profile,
  });
  reportCheck(checks, 'base_sepolia_runtime', runtime == null || runtime === 'base-sepolia', {
    runtime,
  });
  reportCheck(checks, 'base_sepolia_chain_id', String(chainId) === '84532', { chainId });
  reportCheck(checks, 'base_sepolia_network_name', !networkName || networkName === 'Base Sepolia', {
    networkName,
  });
  reportCheck(checks, 'escrow_address_present', isEvmAddress(canonicalEscrowAddress), {
    escrowAddress: canonicalEscrowAddress,
  });
  reportCheck(
    checks,
    'escrow_addresses_consistent',
    uniquePresent(Object.values(escrowAddresses)).length <= 1,
    { escrowAddresses },
  );
  reportCheck(
    checks,
    'usdc_addresses_consistent',
    uniquePresent(Object.values(usdcAddresses)).length <= 1,
    { usdcAddresses },
  );
  reportCheck(
    checks,
    'usdc_address_is_base_sepolia_circle_usdc',
    sameAddress(canonicalUsdcAddress, DEFAULT_BASE_SEPOLIA_USDC),
    { usdcAddress: canonicalUsdcAddress },
  );
  reportCheck(checks, 'deploy_report_present', deployReport != null, {
    deployReportPath: deployReport?.path ?? null,
  });
  if (deployReport) {
    reportCheck(
      checks,
      'deploy_report_chain_matches_profile',
      Number(deployReport.data?.network?.chainId) === 84532,
      { deployReportChainId: deployReport.data?.network?.chainId ?? null },
    );
    reportCheck(
      checks,
      'deploy_report_escrow_matches_profile',
      !canonicalEscrowAddress ||
        sameAddress(deployReport.data?.contract?.address, canonicalEscrowAddress),
      {
        deployReportEscrowAddress: deployReport.data?.contract?.address ?? null,
        profileEscrowAddress: canonicalEscrowAddress,
      },
    );
    const candidateValidation = validateCandidateDeployReport(deployReport.data);
    reportCheck(checks, 'deploy_report_is_candidate_complete', candidateValidation.ok, {
      failures: candidateValidation.failures,
    });
  }

  const session = readSessionPosture(rootDir, sessionFile);
  if (mode === 'live') {
    reportCheck(checks, 'trusted_session_artifact_present', session.present, {
      sessionFile,
      reason: session.reason,
    });
    if (session.present) {
      reportCheck(checks, 'trusted_session_has_bearer', session.hasBearer, {
        accountId: session.accountId,
        role: session.role,
      });
      reportCheck(
        checks,
        'trusted_session_separates_service_auth_from_browser_login',
        session.issuePath !== 'legacy_wallet_login',
        { issuePath: session.issuePath },
      );
    }
  }

  const serviceVersions = readWorkspaceVersions(rootDir);
  const dashboardGatewayBaseUrl = normalizeUrl(
    values.DASHBOARD_GATEWAY_BASE_URL ||
      values.GATEWAY_PUBLIC_BASE_URL ||
      `http://127.0.0.1:${values.GATEWAY_PORT || 3600}`,
    ROUTED_GATEWAY_SUFFIX,
  );
  const authBaseUrl = normalizeUrl(
    values.AUTH_PUBLIC_BASE_URL || values.AUTH_BASE_URL || `http://127.0.0.1:${values.AUTH_PORT || 3005}`,
    ROUTED_AUTH_SUFFIX,
  );

  return {
    generatedAt: now.toISOString(),
    profile,
    mode,
    envSource: env.source,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    chain: {
      runtime,
      networkName,
      chainId: chainId == null ? null : Number(chainId),
      explorerBaseUrl: values.STAGING_E2E_REAL_EXPLORER_BASE_URL || 'https://sepolia.basescan.org',
    },
    contracts: {
      escrowAddress: canonicalEscrowAddress,
      usdcAddress: canonicalUsdcAddress,
      escrowAddresses,
      usdcAddresses,
      deployReportPath: deployReport?.path ?? null,
      deploymentTxHash: deployReport?.data?.contract?.deploymentTxHash ?? null,
      deploymentBlock: deployReport?.data?.contract?.deploymentBlock ?? null,
      verificationStatus: deployReport?.data?.verification?.status ?? null,
    },
    services: {
      required: REQUIRED_SERVICE_NAMES,
      versions: serviceVersions,
    },
    auth: {
      baseUrl: authBaseUrl,
      trustedSessionExchangeRoute: `${authBaseUrl}/session/exchange/agroasys`,
      sessionPosture: session,
    },
    gateway: {
      baseUrl: dashboardGatewayBaseUrl,
      readyzUrl: `${dashboardGatewayBaseUrl}/readyz`,
      capabilitiesUrl: `${dashboardGatewayBaseUrl}/auth/capabilities`,
      governanceStatusUrl: `${dashboardGatewayBaseUrl}/governance/status`,
      treasuryReadUrl: `${dashboardGatewayBaseUrl}/treasury`,
      complianceProbeUrl:
        values.PROTOCOL_HEALTH_COMPLIANCE_TARGET_ID == null
          ? null
          : `${dashboardGatewayBaseUrl}/compliance/trades/${values.PROTOCOL_HEALTH_COMPLIANCE_TARGET_ID}`,
    },
    signerBindings: {
      environment:
        values.PROTOCOL_HEALTH_SIGNER_ENVIRONMENT ||
        values.OPERATOR_SIGNER_ENVIRONMENT ||
        values.VITE_OPERATOR_SIGNER_ENVIRONMENT ||
        profile,
      source: session.signerAuthorizations.length > 0 ? 'session_artifact' : 'not_available_without_session',
      bindings: session.signerAuthorizations,
    },
    treasury: {
      capabilities: session.capabilities.filter((capability) => capability.startsWith('treasury:')),
      expectedCapabilities: [
        'treasury:read',
        'treasury:prepare',
        'treasury:approve',
        'treasury:execute_match',
        'treasury:close',
      ],
    },
    dashHandoff: {
      dashboardGatewayBaseUrl,
      authBaseUrl,
      sessionFile,
      sessionBearerEnv: 'DASHBOARD_GATEWAY_SESSION_BEARER',
      sessionFileEnv: 'DASHBOARD_GATEWAY_SESSION_FILE',
      chainId: chainId == null ? null : Number(chainId),
      escrowAddress: canonicalEscrowAddress,
      usdcAddress: canonicalUsdcAddress,
    },
    checks,
    commands: [],
  };
}

function readWorkspaceVersions(rootDir) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const workspaces = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  const versions = {
    root: {
      name: rootPackage.name,
      version: rootPackage.version ?? null,
      packageManager: rootPackage.packageManager ?? null,
    },
  };
  for (const workspace of workspaces) {
    const packagePath = path.join(rootDir, workspace, 'package.json');
    if (!fs.existsSync(packagePath)) continue;
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    versions[workspace] = {
      name: packageJson.name ?? workspace,
      version: packageJson.version ?? null,
    };
  }
  return versions;
}

function readSessionPosture(rootDir, sessionFile) {
  if (!sessionFile) {
    return {
      present: false,
      reason: 'session artifact not provided',
      hasBearer: false,
      accountId: null,
      role: null,
      issuePath: null,
      capabilities: [],
      signerAuthorizations: [],
    };
  }
  const resolved = path.isAbsolute(sessionFile) ? sessionFile : path.join(rootDir, sessionFile);
  if (!fs.existsSync(resolved)) {
    return {
      present: false,
      reason: 'session artifact path does not exist',
      hasBearer: false,
      accountId: null,
      role: null,
      issuePath: null,
      capabilities: [],
      signerAuthorizations: [],
    };
  }
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const session = data.session ?? data;
  return {
    present: true,
    reason: null,
    hasBearer: Boolean(data.sessionId || data.bearer || data.token || session.sessionId),
    accountId: session.accountId ?? data.accountId ?? null,
    role: session.role ?? data.role ?? null,
    issuePath: data.issuePath ?? data.source ?? null,
    capabilities: Array.isArray(session.capabilities)
      ? session.capabilities
      : Array.isArray(data.capabilities)
        ? data.capabilities
        : [],
    signerAuthorizations: Array.isArray(session.signerAuthorizations)
      ? session.signerAuthorizations
      : Array.isArray(data.signerAuthorizations)
        ? data.signerAuthorizations
        : [],
  };
}

export function attachCommandResults(report, { rootDir, runValidateEnv, runDockerHealth, runStagingGate, timeoutMs }) {
  const commands = [];
  if (runValidateEnv) {
    commands.push(runCommand(rootDir, 'bash', ['scripts/validate-env.sh', report.profile], timeoutMs));
  }
  if (runDockerHealth) {
    commands.push(runCommand(rootDir, 'bash', ['scripts/cotsel.sh', 'health'], timeoutMs));
  }
  if (runStagingGate) {
    commands.push(runCommand(rootDir, 'bash', ['scripts/runtime-gate.sh'], timeoutMs));
  }
  const commandChecks = commands.map((command) => ({
    name: `command:${command.command}`,
    status: command.status,
    exitCode: command.exitCode,
  }));
  return {
    ...report,
    status:
      report.checks.concat(commandChecks).every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks: report.checks.concat(commandChecks),
    commands,
  };
}
