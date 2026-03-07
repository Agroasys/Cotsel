#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethereum-cryptography/keccak";
import { bytesToHex, hexToBytes } from "ethereum-cryptography/utils";
import { evaluateDeployVerificationSmoke } from "./lib/polkavm-deploy-verify-smoke.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    fail(`missing required env var: ${name}`);
  }
  return value.trim();
}

/**
 * Reads an optional environment variable, trimming whitespace.
 * Returns undefined if the variable is not set or is empty after trimming.
 */
function optionalEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHex(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return value.toLowerCase();
}

function toKeccakHex(inputBytes) {
  return `0x${bytesToHex(keccak256(inputBytes))}`;
}

function canonicalJson(value) {
  function canonicalize(v) {
    if (v === null || typeof v !== "object") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(canonicalize);
    }
    const result = {};
    for (const key of Object.keys(v).sort()) {
      result[key] = canonicalize(v[key]);
    }
    return result;
  }
  return JSON.stringify(canonicalize(value));
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatChainIdForFilename(chainId) {
  if (typeof chainId === "string") {
    return chainId.replace(/^0x/u, "");
  }
  if (chainId != null) {
    return String(chainId);
  }
  return "unknown-chainid";
}

function resolveFromRepo(relativeOrAbsolutePath) {
  if (path.isAbsolute(relativeOrAbsolutePath)) {
    return relativeOrAbsolutePath;
  }
  return path.join(repoRoot, relativeOrAbsolutePath);
}

function sanitizeRpcUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function isValidHexString(value) {
  if (typeof value !== "string") {
    return false;
  }
  if (!/^0[xX][0-9a-fA-F]*$/u.test(value)) {
    return false;
  }
  return value.slice(2).length % 2 === 0;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function validateRpcOptions({ retries, timeoutMs, backoffMs }) {
  if (!Number.isInteger(retries) || retries <= 0) {
    throw new Error(`invalid retries value: ${retries}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid timeoutMs value: ${timeoutMs}`);
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(`invalid backoffMs value: ${backoffMs}`);
  }
}

async function rpcCall({ rpcUrl, timeoutMs, retries, backoffMs, method, params }) {
  validateRpcOptions({ retries, timeoutMs, backoffMs });

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`http ${response.status}`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(`rpc ${payload.error.code}: ${payload.error.message}`);
      }

      return payload.result;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(`rpc call failed (${method}) after ${retries} attempts: ${error.message}`);
      }
      await sleep(backoffMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unreachable when retries > 0, kept as a static-analysis safeguard.
  throw new Error(`rpc call failed (${method}) after ${retries} attempts`);
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`unable to read json file ${filePath}: ${error.message}`);
  }
}

function resolveCompilerInfo(artifactPath) {
  const explicitBuildInfoPath = process.env.DEPLOY_VERIFY_BUILD_INFO_PATH;
  if (explicitBuildInfoPath) {
    const buildInfo = loadJson(resolveFromRepo(explicitBuildInfoPath));
    return {
      compilerVersion: buildInfo.solcVersion ?? null,
      solcLongVersion: buildInfo.solcLongVersion ?? null,
    };
  }

  if (!artifactPath.endsWith(".json")) {
    fail(`artifact path does not end with ".json": ${artifactPath}`);
  }

  const dbgPath = artifactPath.replace(/\.json$/u, ".dbg.json");
  if (!fs.existsSync(dbgPath)) {
    return { compilerVersion: null, solcLongVersion: null };
  }

  const dbg = loadJson(dbgPath);
  if (!dbg.buildInfo) {
    return { compilerVersion: null, solcLongVersion: null };
  }

  const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
  const buildInfo = loadJson(buildInfoPath);
  return {
    compilerVersion: buildInfo.solcVersion ?? null,
    solcLongVersion: buildInfo.solcLongVersion ?? null,
  };
}

function resolveHardhatVersion() {
  const envVersion = process.env.DEPLOY_VERIFY_HARDHAT_VERSION;
  if (envVersion && envVersion.trim()) {
    return envVersion.trim();
  }

  try {
    return execSync("npx hardhat --version", {
      cwd: path.join(repoRoot, "contracts"),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const details = stderr ? `\nstderr:\n${stderr}` : "";
    fail(
      `unable to resolve hardhat version using "npx hardhat --version" in ${path.join(
        repoRoot,
        "contracts",
      )}: ${error.message || "unknown error"}${details}\n` +
        "Ensure that Hardhat is installed and that the contracts project has been bootstrapped (e.g., npm/yarn/pnpm install) in the contracts directory.",
    );
  }
}

async function main() {
  const rpcUrl = requiredEnv("DEPLOY_VERIFY_RPC_URL");
  const network = requiredEnv("DEPLOY_VERIFY_NETWORK_NAME");
  const runtimeTarget = requiredEnv("DEPLOY_VERIFY_RUNTIME_TARGET");
  const artifactPath = resolveFromRepo(requiredEnv("DEPLOY_VERIFY_ARTIFACT_PATH"));
  const contractAddress = requiredEnv("DEPLOY_VERIFY_CONTRACT_ADDRESS");
  const txHash = requiredEnv("DEPLOY_VERIFY_TX_HASH");
  const expectedChainId = optionalEnv("DEPLOY_VERIFY_EXPECTED_CHAIN_ID");
  const compilerName = (process.env.DEPLOY_VERIFY_COMPILER_NAME || "solc").trim();
  const timeoutMs = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS));
  const retries = Number(process.env.DEPLOY_VERIFY_RETRIES || String(DEFAULT_RETRIES));
  const backoffMs = Number(process.env.DEPLOY_VERIFY_BACKOFF_MS || String(DEFAULT_BACKOFF_MS));
  const outDir = resolveFromRepo(process.env.DEPLOY_VERIFY_OUT_DIR || "reports/deploy-verification");
  const commitSha =
    (process.env.DEPLOY_VERIFY_COMMIT_SHA || process.env.GITHUB_SHA || "").trim() ||
    execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

  if (!fs.existsSync(artifactPath)) {
    fail(`artifact not found: ${artifactPath}`);
  }
  try {
    validateRpcOptions({ retries, timeoutMs, backoffMs });
  } catch (error) {
    fail(error.message);
  }

  const artifact = loadJson(artifactPath);
  if (!artifact.abi || !Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    fail(`artifact ABI is missing/empty: ${artifactPath}`);
  }
  if (!artifact.deployedBytecode || typeof artifact.deployedBytecode !== "string") {
    fail(`artifact deployedBytecode is missing: ${artifactPath}`);
  }

  const { compilerVersion, solcLongVersion } = resolveCompilerInfo(artifactPath);
  if (!compilerVersion || !solcLongVersion) {
    fail(`unable to resolve compiler version from build info for artifact: ${artifactPath}`);
  }

  const hardhatVersion = resolveHardhatVersion();

  const rpcOptions = { rpcUrl, timeoutMs, retries, backoffMs };
  const chainId = await rpcCall({
    ...rpcOptions,
    method: "eth_chainId",
    params: [],
  });
  let rpcClientVersion = "";
  let rpcClientVersionError = null;
  try {
    rpcClientVersion = await rpcCall({
      ...rpcOptions,
      method: "web3_clientVersion",
      params: [],
    });
  } catch (error) {
    rpcClientVersionError = error.message;
  }
  const onChainCode = await rpcCall({
    ...rpcOptions,
    method: "eth_getCode",
    params: [contractAddress, "latest"],
  });
  const tx = await rpcCall({
    ...rpcOptions,
    method: "eth_getTransactionByHash",
    params: [txHash],
  });
  const receipt = await rpcCall({
    ...rpcOptions,
    method: "eth_getTransactionReceipt",
    params: [txHash],
  });

  if (!isValidHexString(onChainCode)) {
    fail(`RPC returned malformed contract code for ${contractAddress}: ${String(onChainCode)}`);
  }
  if (!isValidHexString(artifact.deployedBytecode)) {
    fail(
      `artifact deployedBytecode is malformed for ${artifactPath}: ${String(
        artifact.deployedBytecode,
      )}`,
    );
  }

  let onChainBytecodeHash = "";
  let artifactBytecodeHash = "";
  try {
    onChainBytecodeHash = toKeccakHex(hexToBytes(onChainCode));
    artifactBytecodeHash = toKeccakHex(hexToBytes(artifact.deployedBytecode));
  } catch (error) {
    fail(`unable to hash bytecode for verification: ${error.message}`);
  }

  // canonicalJson returns a deterministic JSON string; we hash its UTF-8 bytes.
  const abiHash = toKeccakHex(new TextEncoder().encode(canonicalJson(artifact.abi)));
  const deployer = tx?.from ?? null;
  const expectedDeployer = optionalEnv("DEPLOY_VERIFY_DEPLOYER") ?? null;

  const onChainCodeNonEmpty = typeof onChainCode === "string" && onChainCode !== "0x";
  const bytecodeHashMatch = normalizeHex(onChainBytecodeHash) === normalizeHex(artifactBytecodeHash);
  const smokeCheck = evaluateDeployVerificationSmoke({
    runtimeTarget,
    rpcClientVersion,
    rpcClientVersionError,
    chainId,
    expectedChainId,
    tx,
    txHash,
    receipt,
    contractAddress,
    onChainCodeNonEmpty,
    bytecodeHashMatch,
    deployer,
    expectedDeployer,
  });

  const evidence = {
    generatedAt: new Date().toISOString(),
    network,
    chainId,
    compiler: `${compilerName}@${compilerVersion}`,
    compilerName,
    compilerVersion,
    solcLongVersion,
    hardhatVersion,
    deployer,
    txHash,
    contractAddress,
    commitSha,
    runtimeTarget,
    rpcEndpoint: sanitizeRpcUrl(rpcUrl),
    rpcClientVersion,
    rpcClientVersionError,
    expectedChainId: expectedChainId ?? null,
    artifactPath: path.relative(repoRoot, artifactPath),
    onChainBytecodeHash,
    artifactBytecodeHash,
    bytecodeHashMatch: smokeCheck.checks.bytecodeHashMatch,
    abiHash,
    receiptDiagnostics: smokeCheck.receiptDiagnostics,
    smokeCheck,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const chainIdForFilename = formatChainIdForFilename(chainId);
  const outputFile = path.join(
    outDir,
    `deploy-verification-${network}-${chainIdForFilename}-${timestampForFilename()}.json`,
  );
  fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(JSON.stringify({ outputFile: path.relative(repoRoot, outputFile), ...evidence }, null, 2));

  if (!smokeCheck.pass) {
    fail(`smoke checks failed: ${smokeCheck.failedChecks.join(", ")}`);
  }
}

main().catch((error) => {
  fail(error.message);
});
