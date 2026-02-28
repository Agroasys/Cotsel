#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethereum-cryptography/keccak";
import { bytesToHex, hexToBytes } from "ethereum-cryptography/utils";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcCall({ rpcUrl, timeoutMs, retries, backoffMs, method, params }) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

  throw new Error(`rpc call unexpectedly exhausted without result (${method})`);
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
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
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
  const expectedChainId = (process.env.DEPLOY_VERIFY_EXPECTED_CHAIN_ID || "").trim();
  const compilerName = (process.env.DEPLOY_VERIFY_COMPILER_NAME || "solc").trim();
  const timeoutMs = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || "12000");
  const retries = Number(process.env.DEPLOY_VERIFY_RETRIES || "3");
  const backoffMs = Number(process.env.DEPLOY_VERIFY_BACKOFF_MS || "1000");
  const outDir = resolveFromRepo(process.env.DEPLOY_VERIFY_OUT_DIR || "reports/deploy-verification");
  const commitSha =
    (process.env.DEPLOY_VERIFY_COMMIT_SHA || process.env.GITHUB_SHA || "").trim() ||
    execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

  if (!fs.existsSync(artifactPath)) {
    fail(`artifact not found: ${artifactPath}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail(`invalid DEPLOY_VERIFY_TIMEOUT_MS: ${process.env.DEPLOY_VERIFY_TIMEOUT_MS}`);
  }
  if (!Number.isFinite(retries) || retries <= 0) {
    fail(`invalid DEPLOY_VERIFY_RETRIES: ${process.env.DEPLOY_VERIFY_RETRIES}`);
  }
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) {
    fail(`invalid DEPLOY_VERIFY_BACKOFF_MS: ${process.env.DEPLOY_VERIFY_BACKOFF_MS}`);
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

  const onChainBytecodeHash = toKeccakHex(hexToBytes(onChainCode));
  const artifactBytecodeHash = toKeccakHex(hexToBytes(artifact.deployedBytecode));
  const abiHash = toKeccakHex(Buffer.from(canonicalJson(artifact.abi), "utf8"));
  const deployer = tx?.from ?? "";
  const expectedDeployer = (process.env.DEPLOY_VERIFY_DEPLOYER || "").trim();

  const checks = {
    runtimeTargetDeclared: typeof runtimeTarget === "string" && runtimeTarget.length > 0,
    runtimeClientVersionPresent:
      (typeof rpcClientVersion === "string" && rpcClientVersion.length > 0) ||
      !!rpcClientVersionError,
    chainIdMatchesExpected:
      !expectedChainId || normalizeHex(chainId) === normalizeHex(expectedChainId),
    txFound: !!tx,
    receiptFound: !!receipt,
    txHashMatch: normalizeHex(tx?.hash) === normalizeHex(txHash),
    receiptSuccess: normalizeHex(receipt?.status) === "0x1",
    receiptContractAddressMatch:
      normalizeHex(receipt?.contractAddress) === normalizeHex(contractAddress),
    txCreatesContract: tx?.to === null,
    onChainCodeNonEmpty: typeof onChainCode === "string" && onChainCode !== "0x",
    bytecodeHashMatch: normalizeHex(onChainBytecodeHash) === normalizeHex(artifactBytecodeHash),
    // Only enforce deployer match when an expected deployer is configured.
    deployerMatchesExpected: !expectedDeployer
      ? true
      : normalizeHex(deployer) === normalizeHex(expectedDeployer),
  };

  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  const smokePass = failedChecks.length === 0;

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
    expectedChainId: expectedChainId || null,
    artifactPath: path.relative(repoRoot, artifactPath),
    onChainBytecodeHash,
    artifactBytecodeHash,
    bytecodeHashMatch: checks.bytecodeHashMatch,
    abiHash,
    smokeCheck: {
      pass: smokePass,
      checks,
      failedChecks,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outputFile = path.join(
    outDir,
    `deploy-verification-${network}-${chainId.replace(/^0x/u, "")}-${timestampForFilename()}.json`,
  );
  fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(JSON.stringify({ outputFile: path.relative(repoRoot, outputFile), ...evidence }, null, 2));

  if (!smokePass) {
    fail(`smoke checks failed: ${failedChecks.join(", ")}`);
  }
}

main().catch((error) => {
  fail(error.message);
});
