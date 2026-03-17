# TypeScript SDK for Frontend Integration

## Overview

This SDK provides a **type-safe, role-based interface** to the Agroasys smart contract.


## Architecture

The SDK is organized into **three role-based modules**:

* **BuyerSDK** - Create trades, approve USDC, open disputes
* **OracleSDK** - Release funds at logistics milestones, confirm arrival, finalize trade (**Auth verification**)
* **AdminSDK** - Solve frozen trades, propose/approve/execute governance actions (oracle/admin updates) (**Auth verification**)

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

const config = {
  rpc: '',
  chainId: 420420417,
  escrowAddress: '',
  usdcAddress: ''
};

const buyerSDK = new BuyerSDK(config);

const result = await buyerSDK.createTrade(tradeParams, buyerSigner);
```

### Recommended: external Agroasys-managed signer

The production SDK boundary should accept a signer that Agroasys already owns.
That keeps:

- Agroasys auth as the identity authority
- embedded-wallet bootstrap outside the SDK
- Ricardian signing and settlement initiation on the same signer path

Example:

```ts
import { BuyerSDK } from "@agroasys/sdk";
import { ethers } from "ethers";

const buyerSDK = new BuyerSDK(config);
const provider = new ethers.BrowserProvider(agroasysManagedProvider);
const buyerSigner = await provider.getSigner();

const result = await buyerSDK.createTrade(tradeParams, buyerSigner);
```

### Legacy demo helper: Web3Auth wallet provider

```ts
import { web3Wallet } from "@agroasys/sdk";

await web3Wallet.connect();
const address = await web3Wallet.getAddress();
```

`CLIENT_ID` is required. `WEB3AUTH_NETWORK` defaults to `SAPPHIRE_DEVNET`.

This helper is now considered legacy/demo-only. Agroasys production integrations
should not let the SDK become the owner of wallet identity or wallet bootstrap.

## Functions

### BuyerSDK

| Method                         | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `getBuyerNonce(address)`       | Retrieve the current nonce for signature         |
| `approveUSDC(amount, signer)`  | Approve the escrow contract to spend USDC        |
| `getUSDCBalance(address)`      | Check USDC balance                               |
| `getUSDCAllowance(address)`    | Check current USDC allowance for escrow          |
| `createTrade(params, signer)`  | Lock funds and create a new trade                |
| `openDispute(tradeId, signer)` | Open a dispute on an existing trade              |
| `cancelLockedTradeAfterTimeout(tradeId, signer)` | Cancel stale `LOCKED` trade after timeout         |
| `refundInTransitAfterTimeout(tradeId, signer)` | Refund remaining principal when transit times out |



### OracleSDK

| Method                                        | Description                                              |
| --------------------------------------------- | -------------------------------------------------------- |
| `releaseFundsStage1(tradeId, signer)`         | Release first tranche                                    |
| `confirmArrival(tradeId, signer)`             | Confirm goods arrival at destination                     |
| `finalizeAfterDisputeWindow(tradeId, signer)` | Release final tranche after dispute window               |



### AdminSDK

| Method | Description |
| --- | --- |
| `pause(signer)` | Pause normal protocol operations |
| `proposeUnpause(signer)` | Propose unpause (multi-admin) |
| `approveUnpause(signer)` | Approve unpause proposal |
| `cancelUnpauseProposal(signer)` | Cancel active unpause proposal |
| `disableOracleEmergency(signer)` | Emergency disable oracle + pause |
| `proposeDisputeSolution(tradeId, status, signer)` | Propose dispute resolution (`REFUND` or `RESOLVE`) |
| `approveDisputeSolution(proposalId, signer)` | Approve dispute proposal |
| `cancelExpiredDisputeProposal(proposalId, signer)` | Cancel expired dispute proposal |
| `proposeOracleUpdate(newOracle, signer)` | Propose oracle update |
| `approveOracleUpdate(proposalId, signer)` | Approve oracle update |
| `executeOracleUpdate(proposalId, signer)` | Execute approved oracle update |
| `cancelExpiredOracleUpdateProposal(proposalId, signer)` | Cancel expired oracle-update proposal |
| `proposeAddAdmin(newAdmin, signer)` | Propose adding a new admin |
| `approveAddAdmin(proposalId, signer)` | Approve admin-add proposal |
| `executeAddAdmin(proposalId, signer)` | Execute approved admin addition |
| `cancelExpiredAddAdminProposal(proposalId, signer)` | Cancel expired admin-add proposal |

## Auth ownership boundary

Production integrations should follow this boundary:

- Agroasys auth owns user identity
- Agroasys-owned embedded wallet bootstrap owns wallet/session state
- this SDK consumes an injected signer
- Cotsel remains the settlement engine, not the identity root

The exported `web3Wallet` and `AuthClient` helpers remain available for demo
flows, but they are no longer the recommended production integration path.



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
RPC_URL=
CHAIN_ID=

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
