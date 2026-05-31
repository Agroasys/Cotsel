# TypeScript SDK for Frontend Integration

## Overview

This SDK provides a **type-safe, role-based interface** to the Agroasys smart contract.

## Architecture

The SDK is organized into **three role-based modules**:

- **BuyerSDK** - Create gasless settlement authorization packages and buyer/supplier user-action authorization packages
- **OracleSDK** - Release funds at logistics milestones, confirm arrival, finalize trade (**Auth verification**)
- **AdminSDK** - Solve frozen trades, operate protocol controls, manage treasury payout governance, and propose/approve/execute governance actions (**Auth verification**)

All modules extend a shared **Client** base class, which handles provider initialization and common contract reads.

### Project Structure

```
.
├── jest.config.js
├── package.json
├── README.md
├── src
│   ├── client.ts
│   ├── config.ts
│   ├── index.ts
│   ├── modules
│   │   ├── adminSDK.ts
│   │   ├── buyerSDK.ts
│   │   └── oracleSDK.ts
│   ├── types
│   │   ├── dispute.ts
│   │   ├── errors.ts
│   │   ├── governance.ts
│   │   ├── oracle.ts
│   │   ├── trade.ts
│   │   └── typechain-types
│   │       └── // copied from contract module
│   └── utils
│       ├── signature.ts
│       └── validation.ts
├── tests
│   ├── adminSDK.test.ts
│   ├── buyerSDK.test.ts
│   ├── oracleSDK.test.ts
│   └── setup.ts
└── tsconfig.json
```

## Installation & Configuration

```
import { BuyerSDK } from '@agroasys/sdk';
import type { BuyerLockPayload } from '@agroasys/sdk';

const config = {
  rpc: '',
  chainId: 84532,
  escrowAddress: '',
  usdcAddress: ''
};

const buyerSDK = new BuyerSDK(config);

const payload: BuyerLockPayload = {
  supplier: '',
  totalAmount: 0n,
  logisticsAmount: 0n,
  platformFeesAmount: 0n,
  supplierFirstTranche: 0n,
  supplierSecondTranche: 0n,
  ricardianHash: ''
};

const request = await buyerSDK.createGaslessTradeExecutionRequest(payload, buyerSigner, {
  handoffId: '',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});
```

### Recommended: external Agroasys-managed signer

The production SDK boundary should accept a signer that Agroasys already owns.
That keeps:

- Agroasys auth as the identity authority
- embedded-wallet bootstrap outside the SDK
- Ricardian signing and settlement initiation on the same signer path

Example:

```ts
import { BuyerLockPayload, BuyerSDK, createSignerFromEip1193Provider } from '@agroasys/sdk';

const buyerSDK = new BuyerSDK(config);
const buyerSigner = await createSignerFromEip1193Provider(agroasysManagedProvider);
const payload: BuyerLockPayload = {
  supplier: '0xSupplierAddress...',
  totalAmount: 141_500_000n,
  logisticsAmount: 10_000_000n,
  platformFeesAmount: 1_500_000n,
  supplierFirstTranche: 52_000_000n,
  supplierSecondTranche: 78_000_000n,
  ricardianHash: '0x3a4b5c6d...f1e2d3',
};

const request = await buyerSDK.createGaslessTradeExecutionRequest(payload, buyerSigner, {
  handoffId: 'handoff-from-cotsel-gateway',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});
```

Canonical buyer lock payload contract:

- `BuyerLockPayload` is the preferred public type for new integrations.
- `TradeParameters` remains available as a backward-compatible alias.
- Source of truth: `docs/runbooks/buyer-lock-payload.md`

### Recommended: gasless settlement execution

New integrations should ask the buyer signer for typed authorizations only, then
submit the generated package to the Cotsel gasless execution service from a
server-side caller. The buyer does not need native gas for the create-trade,
dispute, lock-timeout cancel, in-transit refund, or dispute-window finalization
paths.

Buyer and supplier `claim()` flows are not exposed because active settlement
versions transfer buyer refunds and supplier payouts directly. Treasury sweeps
remain explicit through `AdminSDK.claimTreasury(...)`.

```ts
import { BuyerSDK, GaslessSettlementClient, SponsoredAction } from '@agroasys/sdk';

const buyerSDK = new BuyerSDK(config);
const gaslessClient = new GaslessSettlementClient(config);

const createTradeRequest = await buyerSDK.createGaslessTradeExecutionRequest(payload, buyerSigner, {
  handoffId: 'handoff-from-cotsel-gateway',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});

await gaslessClient.submitCreateTradeExecution(createTradeRequest, {
  baseUrl: process.env.COTSEL_GATEWAY_URL!,
  idempotencyKey: 'stable-order-or-handoff-key',
  serviceAuth: {
    apiKey: process.env.COTSEL_SERVICE_API_KEY!,
    apiSecret: process.env.COTSEL_SERVICE_API_SECRET!,
  },
});

const refundRequest = await buyerSDK.createGaslessUserActionExecutionRequest(
  SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT,
  tradeId,
  buyerSigner,
  {
    handoffId: 'handoff-from-cotsel-gateway',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  },
);

await gaslessClient.submitUserActionExecution(refundRequest, {
  baseUrl: process.env.COTSEL_GATEWAY_URL!,
  idempotencyKey: 'stable-user-action-key',
  serviceAuth: {
    apiKey: process.env.COTSEL_SERVICE_API_KEY!,
    apiSecret: process.env.COTSEL_SERVICE_API_SECRET!,
  },
});
```

Keep service-auth API secrets on the backend only. Browser/frontend callers
should generate typed authorizations with the buyer signer, then hand those
authorization packages to a trusted backend for submission.

### Embedded-wallet / Web3Auth compatibility contract

The recommended embedded-wallet path is an injected EIP-1193 provider that the
SDK converts into an ethers signer via `createSignerFromEip1193Provider(...)`.

Minimum provider capabilities required by the buyer flow:

- `request({ method: "eth_chainId" })` for network verification
- `request({ method: "eth_accounts" })` or `eth_requestAccounts` for signer resolution
- `request({ method: "eth_signTypedData_v4" })` for trade and USDC authorizations

Buyer and supplier wallets do not submit settlement transactions in the gasless
flow. They sign typed authorizations, then a trusted backend submits the package
through the relayer/gateway.

Deterministic compatibility harness:

```bash
npm run -w sdk test -- --runTestsByPath tests/web3AuthSignerCompatibility.test.ts
```

The harness proves that an EIP-1193/embedded-wallet signer can pass through the
SDK lock flow and produce the typed authorizations expected by the gasless
settlement gateway.

### Legacy demo helper: Web3Auth wallet provider

```ts
import { web3Wallet } from '@agroasys/sdk/legacy';

await web3Wallet.connect();
const address = await web3Wallet.getAddress();
```

`CLIENT_ID` is required. `WEB3AUTH_NETWORK` defaults to `SAPPHIRE_DEVNET`.

This helper is legacy/demo-only.

Do not use it as the default production integration path. Production
integrations should keep wallet bootstrap and identity ownership outside the
SDK and inject a signer instead.

## Functions

### BuyerSDK

| Method                                                                    | Description                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `getAuthorizationNonce(address)`                                          | Retrieve the current typed-authorization nonce               |
| `getUSDCBalance(address)`                                                 | Check USDC balance                                           |
| `createGaslessTradeExecutionRequest(params, signer, input)`               | Build typed create-trade and USDC authorization package      |
| `createGaslessUserActionExecutionRequest(action, tradeId, signer, input)` | Build typed dispute/refund/cancel/finalize package           |
| `createTrade(params, signer)`                                             | Deprecated guard that rejects direct buyer-paid create-trade |
| `openDispute(tradeId, signer)`                                            | Deprecated guard that rejects direct buyer-paid dispute      |
| `cancelLockedTradeAfterTimeout(tradeId, signer)`                          | Deprecated guard that rejects direct buyer-paid cancellation |
| `refundInTransitAfterTimeout(tradeId, signer)`                            | Deprecated guard that rejects direct buyer-paid refund       |

### OracleSDK

| Method                                        | Description                                |
| --------------------------------------------- | ------------------------------------------ |
| `releaseFundsStage1(tradeId, signer)`         | Release first tranche                      |
| `confirmArrival(tradeId, signer)`             | Confirm goods arrival at destination       |
| `finalizeAfterDisputeWindow(tradeId, signer)` | Release final tranche after dispute window |

### AdminSDK

| Method                                                         | Description                                            |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `pause(signer)`                                                | Pause normal protocol operations                       |
| `proposeUnpause(signer)`                                       | Propose unpause (multi-admin)                          |
| `approveUnpause(signer)`                                       | Approve unpause proposal                               |
| `cancelUnpauseProposal(signer)`                                | Cancel active unpause proposal                         |
| `disableOracleEmergency(signer)`                               | Emergency disable oracle + pause                       |
| `pauseClaims(signer)`                                          | Pause treasury/partner claims                          |
| `unpauseClaims(signer)`                                        | Resume treasury/partner claims                         |
| `claimTreasury(signer)`                                        | Sweep accrued treasury USDC with treasury/admin signer |
| `proposeTreasuryPayoutAddressUpdate(address, signer)`          | Propose treasury payout receiver update                |
| `approveTreasuryPayoutAddressUpdate(id, signer)`               | Approve payout receiver update proposal                |
| `executeTreasuryPayoutAddressUpdate(id, signer)`               | Execute approved payout receiver update                |
| `cancelExpiredTreasuryPayoutAddressUpdateProposal(id, signer)` | Cancel expired payout receiver proposal                |
| `proposeDisputeSolution(tradeId, status, signer)`              | Propose dispute resolution (`REFUND` or `RESOLVE`)     |
| `approveDisputeSolution(proposalId, signer)`                   | Approve dispute proposal                               |
| `cancelExpiredDisputeProposal(proposalId, signer)`             | Cancel expired dispute proposal                        |
| `proposeOracleUpdate(newOracle, signer)`                       | Propose oracle update                                  |
| `approveOracleUpdate(proposalId, signer)`                      | Approve oracle update                                  |
| `executeOracleUpdate(proposalId, signer)`                      | Execute approved oracle update                         |
| `cancelExpiredOracleUpdateProposal(proposalId, signer)`        | Cancel expired oracle-update proposal                  |
| `proposeAddAdmin(newAdmin, signer)`                            | Propose adding a new admin                             |
| `approveAddAdmin(proposalId, signer)`                          | Approve admin-add proposal                             |
| `executeAddAdmin(proposalId, signer)`                          | Execute approved admin addition                        |
| `cancelExpiredAddAdminProposal(proposalId, signer)`            | Cancel expired admin-add proposal                      |

## Auth ownership boundary

Production integrations should follow this boundary:

- Agroasys auth owns user identity
- Agroasys-owned embedded wallet bootstrap owns wallet/session state
- this SDK consumes an injected signer
- Cotsel remains the settlement engine, not the identity root

The `web3Wallet` and `AuthClient` helpers remain available from the
`@agroasys/sdk/legacy` entrypoint for demo and backward-compatibility flows.
They are not the recommended production integration path.

## Testing

Integration tests require the `.env` values below. If required values are missing, the SDK integration suites are skipped.

```
npm run test:buyer
npm run test:oracle
npm run test:admin
```

## Environment Variables

Create a `.env` file at the project root:

```
# Network configuration
SETTLEMENT_RUNTIME=
RPC_URL=
RPC_FALLBACK_URLS=
CHAIN_ID=
EXPLORER_BASE_URL=

# Contract addresses
ESCROW_ADDRESS=
USDC_ADDRESS=

# Test wallets
BUYER_PRIVATE_KEY=
ORACLE_PRIVATE_KEY=
ADMIN1_PRIVATE_KEY=
ADMIN2_PRIVATE_KEY=

# Web3Auth wallet provider
CLIENT_ID=
WEB3AUTH_NETWORK=SAPPHIRE_DEVNET
```

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
