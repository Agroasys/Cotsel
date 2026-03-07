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
const artifactPath = path.join(root, "contracts/artifacts/src/AgroasysEscrow.sol/AgroasysEscrow.json");

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const fmt = artifact._format ?? "unknown";

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

const bytecodeHex = artifact.bytecode.startsWith("0x") ? artifact.bytecode.slice(2) : artifact.bytecode;
const argsHex = encodedArgs.startsWith("0x") ? encodedArgs.slice(2) : encodedArgs;
const deployPayloadHex = bytecodeHex + argsHex;

const bytecodeBytes = bytecodeHex.length / 2;
const argsBytes = argsHex.length / 2;
const payloadBytes = deployPayloadHex.length / 2;
const EVM_CAP = 49152;

console.log(`Format        : ${fmt}`);
console.log(`Bytecode      : ${bytecodeBytes.toLocaleString()} bytes (${(bytecodeBytes / 1024).toFixed(1)} KB)`);
console.log(`Encoded args  : ${argsBytes.toLocaleString()} bytes`);
console.log(`Deploy payload: ${payloadBytes.toLocaleString()} bytes (${(payloadBytes / 1024).toFixed(1)} KB)`);
console.log(`EVM cap       : ${EVM_CAP.toLocaleString()} bytes (48 KB, EIP-3860)`);
if (payloadBytes > EVM_CAP) {
  console.log(`Status        : EXCEEDS EVM limit by ${(payloadBytes - EVM_CAP).toLocaleString()} bytes`);
} else {
  console.log(`Status        : within EVM limit`);
}