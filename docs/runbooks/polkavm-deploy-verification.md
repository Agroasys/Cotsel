# Historical PolkaVM Compile and Deploy Verification Runbook

Historical-only notice:
- This runbook is retained for pre-Base migration traceability.
- It is not active operator truth for v1.
- Do not use this runbook for Base Sepolia pilot execution, M4 readiness, or M5 launch preparation.
- Use `.github/workflows/historical-archive-maintenance.yml` only when maintaining historical PolkaVM archive evidence.
- Active runtime and pilot operations must follow the Base-era runbooks, especially:
  - `docs/runbooks/staging-e2e-real-release-gate.md`
  - `docs/runbooks/pilot-environment-onboarding.md`
  - `scripts/base-sepolia-pilot-validation.sh`

## Purpose

Provide deterministic compile evidence for PolkaVM-targeted artifacts and verify deployed contract bytecode on `polkadotTestnet` (Paseo Asset Hub RPC).

## PolkaVM deploy script

`contracts/scripts/deploy-polkavm.ts` is used instead of `hardhat ignition deploy` for PVM deployments.

### Why not Hardhat Ignition?

Hardhat Ignition routes all signed transactions through `LocalAccountsProvider` → `micro-eth-signer`, which enforces the EIP-3860 initcode size limit (49,152 bytes) **client-side**.

PVM binaries produced by resolc are RISC-V executables and are larger than EVM bytecode.

A contract that is ~20 KB as EVM bytecode becomes ~171 KB as a PVM binary, more than 3 times above the EIP-3860 limit. The Polkadot Hub testnet does **not** enforce EIP-3860 (it is a Substrate Contracts pallet accessed via an eth-rpc adapter, not a stock EVM). The rejection is purely client-side tooling.

### How the script works

The script creates its own `ethers.JsonRpcProvider` and `ethers.Wallet` directly. That signing path does not include the `micro-eth-signer` initcode size validation, so the PVM binary can be broadcast to the network without modification.

Private keys are still read from `hre.network.config.accounts` (populated via `npx hardhat vars set PRIVATE_KEY`), so key management is unchanged.

### Usage

Compile to PVM, then deploy:

```bash
# Step 1 — compile
npm run -w contracts compile:polkavm

# Step 2 — deploy
USE_POLKAVM_RESOLC=true npx hardhat run scripts/deploy-polkavm.ts --network polkadotTestnet
```

Or use the combined script (clean + compile + deploy):

```bash
npm run -w contracts deploy:polkavm
```

## Compile Toolchain

- Framework: Hardhat
- Parity plugin stack:
  - `@parity/hardhat-polkadot`
  - `@parity/hardhat-polkadot-resolc`
  - `@parity/resolc`
- Command:

```bash
npm run -w contracts compile:polkavm
```

Legacy fallback compile remains available:

```bash
npm run -w contracts compile
```

Bytecode size report script:

```bash
# requires a compiled artifact at contracts/artifacts/... or an explicit --artifact override
node scripts/polkavm-bytecode-size.mjs
```

Deterministic JSON output for CI or local verification:

```bash
node scripts/polkavm-bytecode-size.mjs --json
```

Fixture or alternate artifact override:

```bash
node scripts/polkavm-bytecode-size.mjs --json --artifact path/to/AgroasysEscrow.json
```

Interpretation:
- `Runtime bytecode` is the deployed contract bytecode size.
- `Initcode` is the deploy-time creation bytecode from the artifact.
- `Deploy payload` is `initcode + ABI-encoded constructor args` and is the value compared against the EIP-3860 48 KB limit.

## resolc Binary Lookup Contract (Plugin Behavior)

`@parity/hardhat-polkadot-resolc` uses Hardhat compiler cache lookup in binary mode:

1. Resolve cache root with:
   - `node -e "require('hardhat/internal/util/global-dir').getCompilersDir().then((d)=>console.log(d))"`
2. Resolve platform folder:
   - `linux-amd64` on Linux
   - `macosx-amd64` on macOS
3. Read `${cacheRoot}/${platform}/resolc-list.json`
4. Find `builds[]` entry where `version` matches configured `resolc.version`
5. Execute binary from `${cacheRoot}/${platform}/${build.path}`

Expected binary names:

- Linux: `resolc-x86_64-unknown-linux-musl`
- macOS: `resolc-universal-apple-darwin`
- Windows: `resolc-x86_64-pc-windows-msvc.exe`

## Deterministic Local Bootstrap (Node 20)

Install pinned `resolc` into Hardhat cache with checksum verification before `compile:polkavm`:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm use 20
npm ci

RESOLC_VERSION="1.0.0"
RESOLC_COMMIT="b080c1"

case "$(uname -s)" in
  Linux)
    HH_PLATFORM="linux-amd64"
    RESOLC_NAME="resolc-x86_64-unknown-linux-musl"
    RESOLC_SHA256="e626ba7a1a0d26828c14713781b0082ececc9a0fbfe984f11f0d93d66bbd7806"
    ;;
  Darwin)
    HH_PLATFORM="macosx-amd64"
    RESOLC_NAME="resolc-universal-apple-darwin"
    RESOLC_SHA256="eaee8e64a863101e95e92e68b1e4e936081a97a68bc9dbf308a63f2d0084ce83"
    ;;
  *)
    echo "Unsupported OS for pinned resolc bootstrap: $(uname -s)"
    exit 1
    ;;
esac

RESOLC_FILE="${RESOLC_NAME}+commit.${RESOLC_COMMIT}"
COMPILERS_DIR="$(node -e "require('hardhat/internal/util/global-dir').getCompilersDir().then((d)=>process.stdout.write(d))")"
PLATFORM_DIR="${COMPILERS_DIR}/${HH_PLATFORM}"
TARGET_BIN="${PLATFORM_DIR}/${RESOLC_FILE}"

mkdir -p "${PLATFORM_DIR}"
curl -fsSL "https://github.com/paritytech/revive/releases/download/v${RESOLC_VERSION}/${RESOLC_NAME}" -o "${TARGET_BIN}"
echo "${RESOLC_SHA256}  ${TARGET_BIN}" | shasum -a 256 -c -
chmod +x "${TARGET_BIN}"

cat > "${PLATFORM_DIR}/resolc-list.json" <<EOF
{
  "builds": [
    {
      "name": "${RESOLC_NAME}",
      "path": "${RESOLC_FILE}",
      "version": "${RESOLC_VERSION}",
      "build": "${RESOLC_COMMIT}",
      "longVersion": "${RESOLC_VERSION}+commit.${RESOLC_COMMIT}.llvm-18.1.8",
      "sha256": "${RESOLC_SHA256}",
      "platform": "${HH_PLATFORM}"
    }
  ],
  "releases": {
    "v${RESOLC_VERSION}": "${RESOLC_FILE}"
  },
  "latestRelease": "v${RESOLC_VERSION}"
}
EOF

"${TARGET_BIN}" --version
```

## Local Compile Evidence Procedure (Node 20)

1. Compile through PolkaVM path:

```bash
npm run -w contracts compile:polkavm
```

2. Capture deterministic artifact hashes:

```bash
mkdir -p reports/polkavm-compile
find contracts/artifacts -type f | LC_ALL=C sort > reports/polkavm-compile/artifact-files.txt
while IFS= read -r file; do shasum -a 256 "$file"; done \
  < reports/polkavm-compile/artifact-files.txt \
  > reports/polkavm-compile/artifact-hashes.txt
shasum -a 256 reports/polkavm-compile/artifact-hashes.txt
```

3. Confirm PolkaVM artifact format exists:

```bash
rg -n "\"_format\": \"hh-resolc-artifact-1\"" contracts/artifacts -S
```

## CI Evidence

`CI Release Gate` (`ci/contracts`) runs `compile:polkavm` and uploads:

- Artifact name: `ci-report-contracts-compile-polkavm`
- Artifact path: `reports/polkavm-compile`
- Bundle file: `reports/polkavm-compile/compile-evidence.json`

Bundle fields include:

- `resolcVersion`
- `solcVersion`
- `solcLongVersion`
- `commitSha`
- `artifactSetHashSha256`
- `artifactFileCount`
- `pvmArtifactCount`

## Deploy Verification

Deployment verification remains a separate check:

```bash
DEPLOY_VERIFY_RPC_URL=https://services.polkadothub-rpc.com/testnet \
DEPLOY_VERIFY_NETWORK_NAME=polkadotTestnet \
DEPLOY_VERIFY_RUNTIME_TARGET=paseo-asset-hub-revive \
DEPLOY_VERIFY_EXPECTED_CHAIN_ID=0x190f1b41 \
DEPLOY_VERIFY_COMPILER_NAME=resolc \
DEPLOY_VERIFY_ARTIFACT_PATH=contracts/artifacts/src/AgroasysEscrow.sol/AgroasysEscrow.json \
DEPLOY_VERIFY_CONTRACT_ADDRESS=[contract-address] \
DEPLOY_VERIFY_TX_HASH=[tx-hash] \
node scripts/polkavm-deploy-verify.mjs
```

Expected output location:

- `reports/deploy-verification/latest.json`
- CI verifies the canonical reference deployment produced by the resolc pipeline.

Required environment contract:

- `DEPLOY_VERIFY_RPC_URL`: revive-capable RPC endpoint
- `DEPLOY_VERIFY_NETWORK_NAME`: network label used in evidence bundle
- `DEPLOY_VERIFY_RUNTIME_TARGET`: runtime target identifier (current CI value: `paseo-asset-hub-revive`)
- `DEPLOY_VERIFY_EXPECTED_CHAIN_ID`: expected `eth_chainId` for the endpoint (`0x190f1b41` for Paseo Hub testnet)
- `DEPLOY_VERIFY_ARTIFACT_PATH`: resolc artifact path (`contracts/artifacts/src/MockUSDC.sol/MockUSDC.json`)

`latest.json` now includes explicit runtime evidence:

- `runtimeTarget`
- `rpcEndpoint`
- `rpcClientVersion`
- `expectedChainId`
- `bytecodeHashMatch`

## Failure Triage

- `chainIdMatchesExpected=false`: wrong endpoint selected or endpoint routing changed.
- `runtimeClientVersionPresent=false`: endpoint does not expose `web3_clientVersion`; treat as unsupported for this gate.
- `txCreatesContract=false` or `receiptContractAddressMatch=false`: tx hash/address mismatch; update canonical reference deployment values.
- `bytecodeHashMatch=false`: artifact/deployment mismatch; rebuild with `compile:polkavm` and verify the reference deployment inputs.
