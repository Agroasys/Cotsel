// SPDX-License-Identifier: Apache-2.0
import { getAddress, isAddress } from "ethers";

export type BaseDeploymentNetworkName = "base-sepolia" | "base-mainnet";

interface BaseDeploymentTarget {
  readonly runtimeKey: "base-sepolia" | "base-mainnet";
  readonly networkName: string;
  readonly chainId: number;
  readonly explorerBaseUrl: string;
  readonly officialUsdcAddress: string;
}

export interface BaseDeploymentConfig {
  readonly target: BaseDeploymentTarget;
  readonly escrowName: "AgroasysEscrow";
  readonly usdcAddress: string;
  readonly oracleAddress: string;
  readonly treasuryAddress: string;
  readonly admins: string[];
  readonly requiredApprovals: number;
  readonly confirmations: number;
  readonly verify: boolean;
  readonly evidenceOutDir: string;
}

const BASE_DEPLOYMENT_TARGETS: Record<BaseDeploymentNetworkName, BaseDeploymentTarget> = {
  "base-sepolia": {
    runtimeKey: "base-sepolia",
    networkName: "Base Sepolia",
    chainId: 84532,
    explorerBaseUrl: "https://sepolia.basescan.org/address/",
    officialUsdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  "base-mainnet": {
    runtimeKey: "base-mainnet",
    networkName: "Base Mainnet",
    chainId: 8453,
    explorerBaseUrl: "https://basescan.org/address/",
    officialUsdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function optionalEnv(name: string, env: NodeJS.ProcessEnv): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function parseBooleanEnv(name: string, env: NodeJS.ProcessEnv, fallback: boolean): boolean {
  const value = optionalEnv(name, env);
  if (value === null) {
    return fallback;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function parsePositiveIntEnv(name: string, env: NodeJS.ProcessEnv, fallback?: number): number {
  const raw = optionalEnv(name, env);
  if (raw === null) {
    if (fallback === undefined) {
      throw new Error(`${name} is required`);
    }

    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseAddress(name: string, value: string): string {
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address, received "${value}"`);
  }

  return getAddress(value);
}

function parseAddressEnv(name: string, env: NodeJS.ProcessEnv): string {
  return parseAddress(name, requiredEnv(name, env));
}

function parseAdminList(env: NodeJS.ProcessEnv): string[] {
  const raw = requiredEnv("DEPLOY_ADMINS", env);
  const admins = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value, index) => parseAddress(`DEPLOY_ADMINS[${index}]`, value));

  if (admins.length === 0) {
    throw new Error("DEPLOY_ADMINS must contain at least one admin address");
  }

  if (admins.length < 2) {
    throw new Error("DEPLOY_ADMINS must contain at least two admin addresses");
  }

  const unique = new Set(admins);
  if (unique.size !== admins.length) {
    throw new Error("DEPLOY_ADMINS must not contain duplicate addresses");
  }

  return admins;
}

export function getBaseDeploymentTarget(networkName: string): BaseDeploymentTarget {
  if (networkName !== "base-sepolia" && networkName !== "base-mainnet") {
    throw new Error(
      `Unsupported Base deployment network "${networkName}". Expected base-sepolia or base-mainnet`,
    );
  }

  return BASE_DEPLOYMENT_TARGETS[networkName];
}

export function loadBaseDeploymentConfig(
  networkName: string,
  chainId: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BaseDeploymentConfig {
  const target = getBaseDeploymentTarget(networkName);
  if (chainId !== undefined && chainId !== null && chainId !== target.chainId) {
    throw new Error(`Network ${networkName} requires chainId=${target.chainId}, received ${chainId}`);
  }

  const configuredUsdcAddress = optionalEnv("DEPLOY_USDC_ADDRESS", env);
  if (configuredUsdcAddress) {
    const normalizedConfiguredUsdc = parseAddress("DEPLOY_USDC_ADDRESS", configuredUsdcAddress);
    if (normalizedConfiguredUsdc !== target.officialUsdcAddress) {
      throw new Error(
        `DEPLOY_USDC_ADDRESS must match the official ${target.networkName} USDC address ${target.officialUsdcAddress}`,
      );
    }
  }

  const oracleAddress = parseAddressEnv("DEPLOY_ORACLE_ADDRESS", env);
  const treasuryAddress = parseAddressEnv("DEPLOY_TREASURY_ADDRESS", env);
  const admins = parseAdminList(env);
  const requiredApprovals = parsePositiveIntEnv("DEPLOY_REQUIRED_APPROVALS", env);
  if (requiredApprovals > admins.length) {
    throw new Error("DEPLOY_REQUIRED_APPROVALS must not exceed the number of admin addresses");
  }

  const confirmations = parsePositiveIntEnv(
    "DEPLOY_CONFIRMATIONS",
    env,
    target.runtimeKey === "base-mainnet" ? 2 : 1,
  );

  return {
    target,
    escrowName: "AgroasysEscrow",
    usdcAddress: target.officialUsdcAddress,
    oracleAddress,
    treasuryAddress,
    admins,
    requiredApprovals,
    confirmations,
    verify: parseBooleanEnv("DEPLOY_VERIFY", env, false),
    evidenceOutDir: optionalEnv("DEPLOY_EVIDENCE_OUT_DIR", env) ?? `reports/deploy/${target.runtimeKey}`,
  };
}
