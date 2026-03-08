import { getCreateAddress } from "ethers";

function normalizeHex(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return value.toLowerCase();
}

function deriveCreateContractAddress(tx) {
  if (!tx || typeof tx.from !== "string" || tx.from.length === 0 || tx.nonce == null) {
    return null;
  }

  try {
    return getCreateAddress({
      from: tx.from,
      nonce: tx.nonce,
    });
  } catch {
    return null;
  }
}

export function evaluateDeployVerificationSmoke({
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
}) {
  const txHashMatch = normalizeHex(tx?.hash) === normalizeHex(txHash);
  const txCreatesContract = !!tx && tx.to === null;
  const derivedContractAddress = deriveCreateContractAddress(tx);
  const derivedContractAddressMatch =
    normalizeHex(derivedContractAddress) === normalizeHex(contractAddress);
  const rawReceiptFound = !!receipt;
  const rawReceiptSuccess = normalizeHex(receipt?.status) === "0x1";
  const rawReceiptContractAddressMatch =
    normalizeHex(receipt?.contractAddress) === normalizeHex(contractAddress);
  const receiptTransactionHashMatch =
    normalizeHex(receipt?.transactionHash) === normalizeHex(txHash);
  const txFallbackUsed =
    !!tx &&
    txHashMatch &&
    txCreatesContract &&
    derivedContractAddressMatch &&
    onChainCodeNonEmpty &&
    bytecodeHashMatch;

  const receiptFallbackUsed =
    !tx &&
    rawReceiptFound &&
    receiptTransactionHashMatch &&
    rawReceiptSuccess &&
    rawReceiptContractAddressMatch &&
    onChainCodeNonEmpty &&
    bytecodeHashMatch;

  const checks = {
    runtimeTargetDeclared: typeof runtimeTarget === "string" && runtimeTarget.length > 0,
    runtimeClientVersionAttempted:
      (typeof rpcClientVersion === "string" && rpcClientVersion.length > 0) ||
      !!rpcClientVersionError,
    chainIdMatchesExpected:
      expectedChainId == null || normalizeHex(chainId) === normalizeHex(expectedChainId),
    txFound: !!tx,
    receiptFound: rawReceiptFound || receiptFallbackUsed || txFallbackUsed,
    txHashMatch,
    receiptTransactionHashMatch: rawReceiptFound
      ? receiptTransactionHashMatch
      : receiptFallbackUsed || txFallbackUsed,
    receiptSuccess: rawReceiptFound ? rawReceiptSuccess : receiptFallbackUsed || txFallbackUsed,
    receiptContractAddressMatch: rawReceiptFound
      ? rawReceiptContractAddressMatch
      : receiptFallbackUsed || txFallbackUsed,
    txCreatesContract,
    txDerivedContractAddressMatch: rawReceiptFound ? true : derivedContractAddressMatch,
    onChainCodeNonEmpty,
    bytecodeHashMatch,
    deployerMatchesExpected:
      expectedDeployer === null ||
      (!!deployer && normalizeHex(deployer) === normalizeHex(expectedDeployer)),
  };

  const waivedChecks = receiptFallbackUsed ? ["txFound", "txHashMatch", "txCreatesContract"] : [];
  const failedChecks = Object.entries(checks)
    .filter(([key, ok]) => !ok && !waivedChecks.includes(key))
    .map(([key]) => key);

  return {
    pass: failedChecks.length === 0,
    checks,
    failedChecks,
    waivedChecks,
    receiptDiagnostics: {
      found: rawReceiptFound,
      success: rawReceiptSuccess,
      contractAddressMatch: rawReceiptContractAddressMatch,
      transactionHashMatch: receiptTransactionHashMatch,
      fallbackUsed: receiptFallbackUsed || txFallbackUsed,
      receiptFallbackUsed,
      txFallbackUsed,
      txDerivedContractAddress: derivedContractAddress,
      txDerivedContractAddressMatch: derivedContractAddressMatch,
    },
  };
}
