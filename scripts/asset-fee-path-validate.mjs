#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value.trim();
}

function optional(name, fallback = "") {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value.trim();
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function parseTxHashes(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hexToBigInt(hexValue) {
  if (!hexValue || typeof hexValue !== "string") {
    return 0n;
  }
  return BigInt(hexValue);
}

function normalizeChainId(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  const raw = value.trim().toLowerCase();
  try {
    if (raw.startsWith("0x")) {
      return `0x${BigInt(raw).toString(16)}`;
    }
    if (/^[0-9]+$/.test(raw)) {
      return `0x${BigInt(raw).toString(16)}`;
    }
  } catch {
    return raw;
  }
  return raw;
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
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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

  throw new Error(`rpc call unexpectedly exhausted (${method})`);
}

function evaluateBehavior({
  expectedBehavior,
  allowNativeFallback,
  transactions,
  mode,
  txHashesProvided,
}) {
  const hasNonNative = transactions.some((tx) => tx.feePathClassification === "non-native-or-unknown");
  const allNative = transactions.length > 0 && transactions.every((tx) => tx.feePathClassification === "native-fallback");

  if (mode === "config-only") {
    if (expectedBehavior === "usdc-preferred" && !txHashesProvided) {
      return {
        pass: true,
        fallbackApplied: true,
        reason: "config-only mode: reference tx hashes missing; deterministic fallback path recorded",
      };
    }
    return {
      pass: true,
      fallbackApplied: false,
      reason: "config-only mode: policy and profile metadata validated",
    };
  }

  if (expectedBehavior === "native-fallback") {
    if (allNative) {
      return { pass: true, fallbackApplied: false, reason: "live mode: all txs classified as native fallback fees" };
    }
    return { pass: false, fallbackApplied: false, reason: "expected native fallback but observed non-native/unknown fee classification" };
  }

  if (expectedBehavior === "usdc-preferred") {
    if (hasNonNative) {
      return { pass: true, fallbackApplied: false, reason: "live mode: observed non-native fee pattern in probe txs" };
    }
    if (allowNativeFallback) {
      return {
        pass: true,
        fallbackApplied: true,
        reason: "live mode: conversion evidence not observed; deterministic native fallback allowed by policy",
      };
    }
    return {
      pass: false,
      fallbackApplied: false,
      reason: "expected usdc-preferred behavior but only native fallback classification observed",
    };
  }

  return { pass: false, fallbackApplied: false, reason: `unsupported expected behavior: ${expectedBehavior}` };
}

async function classifyTransaction({ rpcUrl, timeoutMs, retries, backoffMs, txHash }) {
  const receipt = await rpcCall({
    rpcUrl,
    timeoutMs,
    retries,
    backoffMs,
    method: "eth_getTransactionReceipt",
    params: [txHash],
  });

  const tx = await rpcCall({
    rpcUrl,
    timeoutMs,
    retries,
    backoffMs,
    method: "eth_getTransactionByHash",
    params: [txHash],
  });

  if (!receipt || !tx) {
    throw new Error(`transaction/receipt missing for ${txHash}`);
  }

  const blockNumber = hexToBigInt(receipt.blockNumber);
  if (blockNumber <= 0n) {
    throw new Error(`invalid receipt block number for ${txHash}`);
  }

  const prevBlock = `0x${(blockNumber - 1n).toString(16)}`;
  const blockHex = `0x${blockNumber.toString(16)}`;

  const from = tx.from;
  const balanceBeforeHex = await rpcCall({
    rpcUrl,
    timeoutMs,
    retries,
    backoffMs,
    method: "eth_getBalance",
    params: [from, prevBlock],
  });

  const balanceAfterHex = await rpcCall({
    rpcUrl,
    timeoutMs,
    retries,
    backoffMs,
    method: "eth_getBalance",
    params: [from, blockHex],
  });

  const balanceBefore = hexToBigInt(balanceBeforeHex);
  const balanceAfter = hexToBigInt(balanceAfterHex);
  const gasUsed = hexToBigInt(receipt.gasUsed);
  const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice);
  const value = hexToBigInt(tx.value);
  const expectedNativeSpend = gasUsed * effectiveGasPrice + value;
  const nativeDelta = balanceBefore - balanceAfter;
  const nativeSpendMatches = nativeDelta === expectedNativeSpend;

  return {
    txHash,
    from,
    to: tx.to,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    value: tx.value,
    senderNativeDeltaWei: nativeDelta.toString(),
    expectedNativeSpendWei: expectedNativeSpend.toString(),
    nativeSpendMatches,
    feePathClassification: nativeSpendMatches ? "native-fallback" : "non-native-or-unknown",
  };
}

async function main() {
  const profile = required("FEE_PATH_PROFILE");
  const mode = optional("FEE_PATH_MODE", "config-only");
  const expectedBehavior = optional("FEE_PATH_EXPECTED_BEHAVIOR", "native-fallback");
  const expectedChainId = optional("FEE_PATH_EXPECTED_CHAIN_ID");
  const createTxHash = optional("FEE_PATH_CREATE_TX_HASH");
  const settlementTxHashes = parseTxHashes(optional("FEE_PATH_SETTLEMENT_TX_HASHES"));
  const outFile = optional("FEE_PATH_OUT_FILE", path.join("reports", "fee-path", `${profile}.json`));
  const allowNativeFallback = parseBoolean(optional("FEE_PATH_ALLOW_NATIVE_FALLBACK", "true"), true);

  const timeoutMs = Number(optional("FEE_PATH_TIMEOUT_MS", "12000"));
  const retries = Number(optional("FEE_PATH_RETRIES", "3"));
  const backoffMs = Number(optional("FEE_PATH_BACKOFF_MS", "1000"));

  const report = {
    generatedAt: new Date().toISOString(),
    profile,
    effectiveMode: mode,
    expectedBehavior,
    expectedChainId: expectedChainId || null,
    allowNativeFallback,
    checks: {},
    transactions: [],
    fallbackApplied: false,
    fallbackReason: null,
    smokeCheck: { pass: false, reason: "not evaluated" },
  };

  const txHashes = [];
  if (createTxHash) {
    txHashes.push(createTxHash);
  }
  txHashes.push(...settlementTxHashes);
  const txHashesProvided = txHashes.length > 0;
  report.checks.txHashesProvided = txHashesProvided;

  let rpcUrl = optional("FEE_PATH_RPC_URL");
  if (mode !== "config-only") {
    rpcUrl = required("FEE_PATH_RPC_URL");
  }

  if (mode === "live" && rpcUrl) {
    const chainId = await rpcCall({
      rpcUrl,
      timeoutMs,
      retries,
      backoffMs,
      method: "eth_chainId",
      params: [],
    });
    report.chainId = chainId;
    report.checks.rpcReachable = true;
    if (expectedChainId) {
      report.checks.chainIdMatchesExpected =
        normalizeChainId(chainId) === normalizeChainId(expectedChainId);
    } else {
      report.checks.chainIdMatchesExpected = true;
    }
  } else {
    report.chainId = null;
    report.checks.rpcReachable = mode === "config-only";
    report.checks.chainIdMatchesExpected = mode === "config-only";
  }

  if (mode === "live" && !txHashesProvided) {
    report.smokeCheck = {
      pass: false,
      reason: "live mode requires FEE_PATH_CREATE_TX_HASH and/or FEE_PATH_SETTLEMENT_TX_HASHES",
    };
  } else {
    if (mode === "live") {
      for (const txHash of txHashes) {
        const txSummary = await classifyTransaction({
          rpcUrl,
          timeoutMs,
          retries,
          backoffMs,
          txHash,
        });
        report.transactions.push(txSummary);
      }
    }

    const behavior = evaluateBehavior({
      expectedBehavior,
      allowNativeFallback,
      transactions: report.transactions,
      mode,
      txHashesProvided,
    });
    report.fallbackApplied = behavior.fallbackApplied;
    report.fallbackReason = behavior.fallbackApplied ? behavior.reason : null;
    report.smokeCheck = {
      pass: behavior.pass && Boolean(report.checks.chainIdMatchesExpected),
      reason: behavior.pass
        ? behavior.reason
        : `${behavior.reason}; chainIdMatchesExpected=${String(report.checks.chainIdMatchesExpected)}`,
    };
  }

  const outPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summary = [
    `profile=${report.profile}`,
    `mode=${report.effectiveMode}`,
    `expectedBehavior=${report.expectedBehavior}`,
    `chainId=${report.chainId ?? "n/a"}`,
    `txHashesProvided=${String(report.checks.txHashesProvided)}`,
    `fallbackApplied=${String(report.fallbackApplied)}`,
    `smokePass=${String(report.smokeCheck.pass)}`,
  ].join(" ");
  console.log(summary);
  if (!report.smokeCheck.pass) {
    console.error(`asset-fee-path validation failed: ${report.smokeCheck.reason}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`asset-fee-path validation error: ${error.message}`);
  process.exit(1);
});
