#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder } from "ethers";

// Mirror the exact constructor arguments used by contracts/scripts/deploy-polkavm.ts
const DEPLOY_ARGS = {
  usdcAddress:"0xEea5766E43D0c7032463134Afc121e63C9f9C260",
  oracleAddress:"0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
  treasuryAddress:"0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
  admins: [
    "0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D",
    "0x229C75F0cD13D6ab7621403Bd951a9e43ba53b1e",
    "0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c",
  ],
  requiredApprovals: 2,
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactPath = path.join(root, "contracts/artifacts/src/AgroasysEscrow.sol/AgroasysEscrow.json");
const args = process.argv.slice(2);

function parseArtifactPath(argv) {
  const flagIndex = argv.indexOf("--artifact");
  if (flagIndex === -1) {
    return defaultArtifactPath;
  }

  const rawPath = argv[flagIndex + 1];
  if (!rawPath || rawPath.startsWith("--")) {
    throw new Error("Missing value for --artifact");
  }

  return path.resolve(root, rawPath);
}

function loadArtifact(artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found at ${artifactPath}. ` +
      "Run 'npm run -w contracts compile:polkavm' first or pass --artifact <path>."
    );
  }

  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

const artifactPath = parseArtifactPath(args);
const artifact = loadArtifact(artifactPath);
const fmt = artifact._format ?? "unknown";
const EVM_CAP = 49152;

function normalizeHex(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.startsWith("0x") ? value.slice(2) : value;
}

function resolveRuntimeBytecodeHex(inputArtifact) {
  if (typeof inputArtifact.deployedBytecode === "string") {
    return normalizeHex(inputArtifact.deployedBytecode);
  }

  if (typeof inputArtifact.deployedBytecode?.object === "string") {
    return normalizeHex(inputArtifact.deployedBytecode.object);
  }

  return "";
}

const ctorFragment = artifact.abi.find((f) => f.type === "constructor");
if (!ctorFragment) throw new Error("No constructor found in artifact ABI");
const types = ctorFragment.inputs.map((i) => i.type);
const values = [
  DEPLOY_ARGS.usdcAddress,
  DEPLOY_ARGS.oracleAddress,
  DEPLOY_ARGS.treasuryAddress,
  DEPLOY_ARGS.admins,
  DEPLOY_ARGS.requiredApprovals,
];
const encodedArgs = AbiCoder.defaultAbiCoder().encode(types, values);

const initcodeHex = normalizeHex(artifact.bytecode);
const runtimeBytecodeHex = resolveRuntimeBytecodeHex(artifact);
const argsHex = normalizeHex(encodedArgs);
const deployPayloadHex = initcodeHex + argsHex;

const runtimeBytecodeBytes = runtimeBytecodeHex.length / 2;
const initcodeBytes = initcodeHex.length / 2;
const argsBytes = argsHex.length / 2;
const payloadBytes = deployPayloadHex.length / 2;
const exceedsByBytes = payloadBytes > EVM_CAP ? payloadBytes - EVM_CAP : 0;

const report = {
  format: fmt,
  artifactPath: path.relative(root, artifactPath),
  runtimeBytecodeBytes,
  initcodeBytes,
  encodedArgsBytes: argsBytes,
  deployPayloadBytes: payloadBytes,
  evmDeployPayloadCapBytes: EVM_CAP,
  evmDeployPayloadStatus: payloadBytes > EVM_CAP ? "exceeds_limit" : "within_limit",
  exceedsByBytes,
};

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`Format                  : ${report.format}`);
console.log(`Runtime bytecode        : ${runtimeBytecodeBytes.toLocaleString()} bytes (${(runtimeBytecodeBytes / 1024).toFixed(1)} KB)`);
console.log(`Initcode                : ${initcodeBytes.toLocaleString()} bytes (${(initcodeBytes / 1024).toFixed(1)} KB)`);
console.log(`Encoded constructor args: ${argsBytes.toLocaleString()} bytes`);
console.log(`Deploy payload          : ${payloadBytes.toLocaleString()} bytes (${(payloadBytes / 1024).toFixed(1)} KB)`);
console.log(`EVM cap                 : ${EVM_CAP.toLocaleString()} bytes (48 KB, EIP-3860 deploy payload cap)`);
if (payloadBytes > EVM_CAP) {
  console.log(`Status                  : EXCEEDS EVM deploy payload limit by ${exceedsByBytes.toLocaleString()} bytes`);
} else {
  console.log("Status                  : within EVM deploy payload limit");
}
