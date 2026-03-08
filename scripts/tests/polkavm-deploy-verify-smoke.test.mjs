import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDeployVerificationSmoke } from "../lib/polkavm-deploy-verify-smoke.mjs";

test("passes when transaction lookup and receipt both confirm deployment", () => {
  const result = evaluateDeployVerificationSmoke({
    runtimeTarget: "paseo-asset-hub-revive",
    rpcClientVersion: "eth-rpc/test",
    rpcClientVersionError: null,
    chainId: "0x190f1b41",
    expectedChainId: "0x190f1b41",
    tx: {
      hash: "0xabc123",
      to: null,
      from: "0x1111111111111111111111111111111111111111",
    },
    txHash: "0xabc123",
    receipt: {
      transactionHash: "0xabc123",
      status: "0x1",
      contractAddress: "0x2222222222222222222222222222222222222222",
    },
    contractAddress: "0x2222222222222222222222222222222222222222",
    onChainCodeNonEmpty: true,
    bytecodeHashMatch: true,
    deployer: "0x1111111111111111111111111111111111111111",
    expectedDeployer: null,
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(result.waivedChecks, []);
  assert.equal(result.receiptDiagnostics.fallbackUsed, false);
});

test("passes with strict receipt-backed fallback when transaction lookup is unavailable", () => {
  const result = evaluateDeployVerificationSmoke({
    runtimeTarget: "paseo-asset-hub-revive",
    rpcClientVersion: "eth-rpc/test",
    rpcClientVersionError: null,
    chainId: "0x190f1b41",
    expectedChainId: "0x190f1b41",
    tx: null,
    txHash: "0xdef456",
    receipt: {
      transactionHash: "0xdef456",
      status: "0x1",
      contractAddress: "0x3333333333333333333333333333333333333333",
    },
    contractAddress: "0x3333333333333333333333333333333333333333",
    onChainCodeNonEmpty: true,
    bytecodeHashMatch: true,
    deployer: null,
    expectedDeployer: null,
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(result.waivedChecks, ["txFound", "txHashMatch", "txCreatesContract"]);
  assert.equal(result.checks.txFound, false);
  assert.equal(result.checks.receiptTransactionHashMatch, true);
  assert.equal(result.receiptDiagnostics.fallbackUsed, true);
  assert.equal(result.receiptDiagnostics.receiptFallbackUsed, true);
  assert.equal(result.receiptDiagnostics.txFallbackUsed, false);
});

test("passes with strict transaction-backed fallback when receipt lookup is unavailable", () => {
  const result = evaluateDeployVerificationSmoke({
    runtimeTarget: "paseo-asset-hub-revive",
    rpcClientVersion: "eth-rpc/test",
    rpcClientVersionError: null,
    chainId: "0x190f1b41",
    expectedChainId: "0x190f1b41",
    tx: {
      hash: "0xaaa111",
      to: null,
      from: "0x1111111111111111111111111111111111111111",
      nonce: "0x5",
    },
    txHash: "0xaaa111",
    receipt: null,
    contractAddress: "0xa0BCB2140DcE5CF8DD708C6C2174248B8E4279c0",
    onChainCodeNonEmpty: true,
    bytecodeHashMatch: true,
    deployer: "0x1111111111111111111111111111111111111111",
    expectedDeployer: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(result.waivedChecks, []);
  assert.equal(result.checks.txFound, true);
  assert.equal(result.checks.txHashMatch, true);
  assert.equal(result.checks.txCreatesContract, true);
  assert.equal(result.checks.txDerivedContractAddressMatch, true);
  assert.equal(result.checks.receiptFound, true);
  assert.equal(result.checks.receiptSuccess, true);
  assert.equal(result.receiptDiagnostics.fallbackUsed, true);
  assert.equal(result.receiptDiagnostics.receiptFallbackUsed, false);
  assert.equal(result.receiptDiagnostics.txFallbackUsed, true);
});

test("fails when transaction lookup is present but does not derive the expected contract address", () => {
  const result = evaluateDeployVerificationSmoke({
    runtimeTarget: "paseo-asset-hub-revive",
    rpcClientVersion: "eth-rpc/test",
    rpcClientVersionError: null,
    chainId: "0x190f1b41",
    expectedChainId: "0x190f1b41",
    tx: {
      hash: "0xbbb222",
      to: null,
      from: "0x1111111111111111111111111111111111111111",
      nonce: "0x5",
    },
    txHash: "0xbbb222",
    receipt: null,
    contractAddress: "0x2222222222222222222222222222222222222222",
    onChainCodeNonEmpty: true,
    bytecodeHashMatch: true,
    deployer: "0x1111111111111111111111111111111111111111",
    expectedDeployer: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(result.pass, false);
  assert.deepEqual(result.waivedChecks, []);
  assert.deepEqual(result.failedChecks, [
    "receiptFound",
    "receiptTransactionHashMatch",
    "receiptSuccess",
    "receiptContractAddressMatch",
    "txDerivedContractAddressMatch",
  ]);
  assert.equal(result.receiptDiagnostics.fallbackUsed, false);
  assert.equal(result.receiptDiagnostics.txFallbackUsed, false);
});

test("fails when receipt lookup is present but does not prove the requested transaction", () => {
  const result = evaluateDeployVerificationSmoke({
    runtimeTarget: "paseo-asset-hub-revive",
    rpcClientVersion: "eth-rpc/test",
    rpcClientVersionError: null,
    chainId: "0x190f1b41",
    expectedChainId: "0x190f1b41",
    tx: null,
    txHash: "0xdef456",
    receipt: {
      transactionHash: "0xfeedbeef",
      status: "0x1",
      contractAddress: "0x3333333333333333333333333333333333333333",
    },
    contractAddress: "0x3333333333333333333333333333333333333333",
    onChainCodeNonEmpty: true,
    bytecodeHashMatch: true,
    deployer: null,
    expectedDeployer: null,
  });

  assert.equal(result.pass, false);
  assert.deepEqual(result.waivedChecks, []);
  assert.deepEqual(result.failedChecks, ["txFound", "txHashMatch", "receiptTransactionHashMatch", "txCreatesContract"]);
  assert.equal(result.receiptDiagnostics.fallbackUsed, false);
});
