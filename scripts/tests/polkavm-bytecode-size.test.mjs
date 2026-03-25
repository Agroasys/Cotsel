#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "polkavm-bytecode-size.mjs");

const stdout = execFileSync(process.execPath, [scriptPath, "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});

const report = JSON.parse(stdout);

assert.equal(typeof report.format, "string");
assert.equal(typeof report.runtimeBytecodeBytes, "number");
assert.equal(typeof report.initcodeBytes, "number");
assert.equal(typeof report.encodedArgsBytes, "number");
assert.equal(typeof report.deployPayloadBytes, "number");
assert.equal(typeof report.evmDeployPayloadCapBytes, "number");
assert.equal(typeof report.evmDeployPayloadStatus, "string");

assert.ok(report.runtimeBytecodeBytes > 0, "runtime bytecode bytes should be positive");
assert.ok(report.initcodeBytes > 0, "initcode bytes should be positive");
assert.ok(report.encodedArgsBytes > 0, "encoded constructor args bytes should be positive");
assert.equal(
  report.deployPayloadBytes,
  report.initcodeBytes + report.encodedArgsBytes,
  "deploy payload bytes should equal initcode plus encoded constructor args",
);
assert.ok(
  ["within_limit", "exceeds_limit"].includes(report.evmDeployPayloadStatus),
  "status should be one of the expected values",
);
assert.equal(
  report.exceedsByBytes,
  report.deployPayloadBytes > report.evmDeployPayloadCapBytes
    ? report.deployPayloadBytes - report.evmDeployPayloadCapBytes
    : 0,
  "exceedsByBytes should match the deploy payload comparison",
);

console.log("polkavm-bytecode-size test: pass");
