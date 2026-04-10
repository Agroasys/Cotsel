# Solidity Smart Contract (Base EVM)

## Overview

A Solidity-based state machine prepared for Base EVM deployment. It handles the locking, dispute resolution, and atomic splitting of funds.

## Architecture

```bash
.
├── hardhat.config.ts // hardhat config file
├── package.json
├── README.md
├── src
│   ├── AgroasysEscrow.sol // Escrow smart contract
│   └── MockUSDC.sol
├── tests
│   └── AgroasysEscrow.ts // Unit and integration tests
├── tsconfig.json
├── ignition
│   └── modules // deployment scripts
│      ├── AgroasysEscrow.ts
│      └── MockUSDC.ts
├── foundry
│   ├── foundry.toml // foundry config file
│   ├── src
│   │   ├── AgroasysEscrow.sol
│   │   └── MockUSDC.sol // tmp contract just for testing
│   └── test
│       ├── AgroasysEscrowFuzz.t.sol // Stateless fuzzing tests
│       └── AgroasysEscrowInvariant.t.sol // Stateful invariant tests

```

## Contracts structure

### Contract: `AgroasysEscrow.sol`

Escrow contract implementing secure trade execution with multi-stage fund releases and dispute resolution.

#### **Enums**

**`TradeStatus`**

- `LOCKED`: Initial deposit, funds locked in escrow
- `IN_TRANSIT`: BOL verified, stage 1 funds released (logistics + first tranche)
- `ARRIVAL_CONFIRMED`: Oracle confirms arrival, 24-hour dispute window starts
- `FROZEN`: Buyer raised dispute within 24h window, funds frozen
- `CLOSED`: Trade completed or dispute resolved

**`DisputeStatus`**

- `REFUND`: Refund buyer remaining escrowed principal (`supplierSecondTranche` only)
- `RESOLVE`: Pay supplier remaining escrowed principal (`supplierSecondTranche` only)

#### **Structs**

**`Trade`**
Complete trade data structure stored on-chain:

- `tradeId` (uint256): Unique identifier, auto-incremented
- `ricardianHash` (bytes32): Immutable proof of agreement (SHA-256 of legal contract)
- `status` (TradeStatus): Current trade state
- `buyerAddress` (address): Creates the trade, pays totalAmount
- `supplierAddress` (address): Receives first and second tranches
- `totalAmountLocked` (uint256): Total amount locked by buyer
- `logisticsAmount` (uint256): Logistics fees (paid at stage 1)
- `platformFeesAmount` (uint256): Platform fees (paid at stage 1)
- `supplierFirstTranche` (uint256): First payment to supplier (paid at stage 1, ~40%)
- `supplierSecondTranche` (uint256): Second payment to supplier (paid at stage 2, ~60%)
- `createdAt` (uint256): Trade creation timestamp
- `arrivalTimestamp` (uint256): Arrival confirmation timestamp (starts 24h window)

**`DisputeProposal`**
Multi-signature dispute proposal structure:

- `tradeId` (uint256): Trade being disputed
- `disputeStatus` (DisputeStatus): Proposed resolution method
- `approvalCount` (uint256): Number of admin approvals received
- `executed` (bool): Prevents double execution
- `createdAt` (uint256): Proposal creation timestamp
- `proposer` (address): Admin who proposed the solution

**`OracleUpdateProposal`**
Timelock-based oracle rotation proposal:

- `newOracle` (address): Proposed new oracle address
- `approvalCount` (uint256): Number of admin approvals received
- `executed` (bool): Prevents double execution
- `createdAt` (uint256): Proposal creation timestamp
- `eta` (uint256): Earliest execution timestamp (timelock)
- `proposer` (address): Admin who proposed the update
- `emergencyFastTrack` (bool): True when proposed while oracle is disabled

**`AdminAddProposal`**
Timelock-based admin addition proposal:

- `newAdmin` (address): Proposed new admin address
- `approvalCount` (uint256): Number of admin approvals received
- `executed` (bool): Prevents double execution
- `createdAt` (uint256): Proposal creation timestamp
- `eta` (uint256): Earliest execution timestamp (timelock)
- `proposer` (address): Admin who proposed the addition

#### **State Variables**

**Storage Mappings:**

- `trades` (mapping(uint256 => Trade)): All trades indexed by ID
- `nonces` (mapping(address => uint256)): Buyer-scoped nonces for signature replay protection
- `disputeProposals` (mapping(uint256 => DisputeProposal)): All dispute proposals
- `disputeHasApproved` (mapping(uint256 => mapping(address => bool))): Tracks admin approvals per dispute
- `tradeHasActiveDisputeProposal` (mapping(uint256 => bool)): Prevents multiple active disputes per trade
- `isAdmin` (mapping(address => bool)): Admin authorization mapping
- `oracleUpdateProposals` (mapping(uint256 => OracleUpdateProposal)): Oracle update proposals
- `oracleUpdateHasApproved` (mapping(uint256 => mapping(address => bool))): Tracks approvals per oracle update
- `adminAddProposals` (mapping(uint256 => AdminAddProposal)): Admin addition proposals
- `adminAddHasApproved` (mapping(uint256 => mapping(address => bool))): Tracks approvals per admin addition

**Counters:**

- `tradeCounter` (uint256): Auto-incrementing trade ID
- `disputeCounter` (uint256): Auto-incrementing dispute proposal ID
- `oracleUpdateCounter` (uint256): Auto-incrementing oracle update proposal ID
- `adminAddCounter` (uint256): Auto-incrementing admin addition proposal ID

**Configuration:**

- `usdcToken` (IERC20): USDC token contract interface
- `oracleAddress` (address): Authorized oracle for fund releases and arrival confirmation
- `treasuryAddress` (address): Receives logistics and platform fees
- `paused` (bool): Global pause flag for normal protocol operations
- `oracleActive` (bool): Oracle execution enable/disable switch
- `admins` (address[]): Array of admin addresses
- `requiredApprovals` (uint256): Minimum approvals required to execute dispute
- `governanceTimelock` (uint256): Delay (24h) between approval and execution for governance operations
- `DISPUTE_WINDOW` (constant uint256): 24-hour window for buyer to open dispute after arrival
- `LOCK_TIMEOUT` (constant uint256): Buyer timeout to cancel LOCKED trade
- `IN_TRANSIT_TIMEOUT` (constant uint256): Buyer timeout to refund principal while IN_TRANSIT
- `DISPUTE_PROPOSAL_TTL` (constant uint256): Dispute proposal expiry
- `GOVERNANCE_PROPOSAL_TTL` (constant uint256): Governance proposal expiry

#### **Functions**

**Public/External Functions:**

1. **`createTrade(supplier, totalAmount, logisticsAmount, platformFeesAmount, supplierFirstTranche, supplierSecondTranche, ricardianHash, buyerNonce, deadline, signature)`**
   - Creates new trade with buyer signature verification using buyer-scoped nonce
   - Locks funds in escrow (USDC transferFrom buyer)
   - Returns: `tradeId`
   - Emits: `TradeLocked`
   - Access: Anyone (msg.sender becomes buyer), blocked if paused
   - Requires: Valid signature with matching nonce and deadline, non-zero addresses, amounts matching breakdown, USDC approval

2. **`releaseFundsStage1(tradeId)`**
   - Releases first stage funds after BOL verification
   - Pays: supplier (first tranche) + treasury (logistics + platform fees)
   - Changes status: LOCKED to IN_TRANSIT
   - Emits: `FundsReleasedStage1`, `PlatformFeesPaidStage1`
   - Access: `onlyOracle`, `onlyOracleActive`, `whenNotPaused`

3. **`confirmArrival(tradeId)`**
   - Confirms goods arrival, starts 24-hour dispute window
   - Changes status: IN_TRANSIT to ARRIVAL_CONFIRMED
   - Sets `arrivalTimestamp` to current block timestamp
   - Emits: `ArrivalConfirmed`
   - Access: `onlyOracle`, `onlyOracleActive`, `whenNotPaused`

4. **`openDispute(tradeId)`**
   - Buyer opens dispute within 24-hour window
   - Freezes all remaining funds in escrow
   - Changes status: ARRIVAL_CONFIRMED to FROZEN
   - Emits: `DisputeOpenedByBuyer`
   - Access: Trade buyer only (`whenNotPaused`)
   - Requires: Called before `arrivalTimestamp + 24 hours`

5. **`finalizeAfterDisputeWindow(tradeId)`**
   - Finalizes trade after 24h dispute window expires (permissionless)
   - Pays: supplier (second tranche only)
   - Changes status: ARRIVAL_CONFIRMED to CLOSED
   - Emits: `FinalTrancheReleased`
   - Access: Anyone (`whenNotPaused`, permissionless to avoid funds getting stuck)
   - Requires: Called after `arrivalTimestamp + 24 hours`

6. **`cancelLockedTradeAfterTimeout(tradeId)`**
   - Buyer escape hatch when a trade remains `LOCKED` past `LOCK_TIMEOUT`
   - Refunds full `totalAmountLocked` to buyer
   - Changes status: LOCKED to CLOSED
   - Emits: `TradeCancelledAfterLockTimeout`
   - Access: Trade buyer only

7. **`refundInTransitAfterTimeout(tradeId)`**
   - Buyer escape hatch when trade remains `IN_TRANSIT` past `IN_TRANSIT_TIMEOUT`
   - Refunds only remaining escrowed principal (`supplierSecondTranche`)
   - Changes status: IN_TRANSIT to CLOSED
   - Emits: `InTransitTimeoutRefunded`
   - Access: Trade buyer only

8. **`proposeDisputeSolution(tradeId, disputeStatus)`**
   - Creates dispute resolution proposal
   - First admin approval automatically counted
   - Returns: `proposalId`
   - Emits: `DisputeSolutionProposed`
   - Access: `onlyAdmin`, `whenNotPaused`
   - Requires: Trade status must be FROZEN

9. **`approveDisputeSolution(proposalId)`**
   - Adds admin approval to dispute proposal
   - Auto-executes `_executeDispute()` when threshold reached
   - Emits: `DisputeApproved`, potentially `DisputeFinalized`
   - Access: `onlyAdmin`, `whenNotPaused`
   - Requires: Not already approved by this admin, proposal not executed

10. **`cancelExpiredDisputeProposal(proposalId)`**

- Cancels expired dispute proposal
- Emits: `DisputeProposalExpiredCancelled`
- Access: `onlyAdmin`, `whenNotPaused`

11. **`pause()`**

- Emergency pause for protocol operations
- Emits: `Paused`
- Access: `onlyAdmin`

12. **`proposeUnpause()`**

- Starts unpause recovery proposal
- Emits: `UnpauseProposed`, `UnpauseApproved`
- Access: `onlyAdmin`
- Requires: `paused == true` and `oracleActive == true`

13. **`approveUnpause()`**

- Adds approval to active unpause proposal
- Emits: `UnpauseApproved`, and `Unpaused` once quorum is reached
- Access: `onlyAdmin`

14. **`cancelUnpauseProposal()`**

- Cancels active unpause proposal
- Emits: `UnpauseProposalCancelled`
- Access: `onlyAdmin`

15. **`disableOracleEmergency()`**

- Emergency containment: disables oracle-triggered transitions and pauses protocol
- Emits: `OracleDisabledEmergency` (and `Paused` if not already paused)
- Access: `onlyAdmin`

16. **`getNextTradeId()`**

- Returns the next available trade ID
- Returns: `tradeCounter`
- Access: View function (anyone)

17. **`getBuyerNonce(buyer)`**

- Returns the current nonce for a buyer address
- Returns: `nonces[buyer]`
- Access: View function (anyone)

**Governance Functions:**

18. **`proposeOracleUpdate(newOracle)`**
    - Creates timelock-based oracle rotation proposal
    - First admin approval automatically counted
    - Returns: `proposalId`
    - Emits: `OracleUpdateProposed`, `OracleUpdateApproved`
    - Access: `onlyAdmin`
    - Requires: Minimum 2 admin approvals (even if requiredApprovals == 1)

19. **`approveOracleUpdate(proposalId)`**
    - Adds admin approval to oracle update proposal
    - Emits: `OracleUpdateApproved`
    - Access: `onlyAdmin`
    - Requires: Not already approved by this admin, proposal not executed

20. **`executeOracleUpdate(proposalId)`**
    - Executes approved oracle update after timelock or emergency fast-track
    - Emits: `OracleUpdated`
    - Access: `onlyAdmin`
    - Requires: Sufficient approvals; timelock elapsed for normal proposals, immediate execution for emergency fast-track proposals

21. **`cancelExpiredOracleUpdateProposal(proposalId)`**
    - Cancels expired oracle update proposal
    - Emits: `OracleUpdateProposalExpiredCancelled`
    - Access: `onlyAdmin`

22. **`proposeAddAdmin(newAdmin)`**
    - Creates timelock-based admin addition proposal
    - First admin approval automatically counted
    - Returns: `proposalId`
    - Emits: `AdminAddProposed`, `AdminAddApproved`
    - Access: `onlyAdmin`
    - Requires: Minimum 2 admin approvals (even if requiredApprovals == 1)

23. **`approveAddAdmin(proposalId)`**
    - Adds admin approval to admin addition proposal
    - Emits: `AdminAddApproved`
    - Access: `onlyAdmin`
    - Requires: Not already approved by this admin, proposal not executed

24. **`executeAddAdmin(proposalId)`**
    - Executes approved admin addition after timelock expires
    - Emits: `AdminAdded`
    - Access: `onlyAdmin`
    - Requires: Sufficient approvals, timelock elapsed (24h)

25. **`cancelExpiredAddAdminProposal(proposalId)`**
    - Cancels expired admin-add proposal
    - Emits: `AdminAddProposalExpiredCancelled`
    - Access: `onlyAdmin`

26. **`governanceApprovals()`**
    - Returns minimum approvals required for governance operations
    - Returns: `max(2, requiredApprovals)` for extra security
    - Access: View function (anyone)

**Internal Functions:**

17. **`_verifySignature(...)`**
    - Verifies buyer's signature on trade parameters with nonce and deadline
    - Uses domain separation (chainId + contract address)
    - Returns: Recovered signer address
    - Access: Internal (called by `createTrade`)

18. **`_executeDispute(proposalId)`**
    - Executes approved dispute resolution
    - Distribution based on `DisputeStatus`:
      - `REFUND`: buyer receives second tranche (principal)
      - `RESOLVE`: supplier receives second tranche (principal)
    - Note: Platform/logistics fees already paid at Stage 1, not refunded
    - Changes status: FROZEN to CLOSED
    - Emits: `DisputeFinalized`
    - Access: Internal (called by `approveDisputeSolution`)

#### **Modifiers**

- `onlyOracle`: Restricts function to authorized oracle address
- `onlyAdmin`: Restricts function to approved admin addresses
- `whenNotPaused`: Blocks normal state transitions while paused
- `onlyOracleActive`: Blocks oracle-triggered functions when oracle is disabled
- `nonReentrant`: OpenZeppelin protection against reentrancy attacks

#### **Events**

**Trade Events:**

- `TradeLocked(tradeId, buyer, supplier, totalAmount, logisticsAmount, platformFeesAmount, supplierFirstTranche, supplierSecondTranche, ricardianHash)`: New trade created and funds locked
- `FundsReleasedStage1(tradeId, supplier, supplierFirstTranche, treasury, logisticsAmount)`: Stage 1 funds released (first tranche + logistics)
- `PlatformFeesPaidStage1(tradeId, treasury, platformFeesAmount)`: Platform fees paid at Stage 1
- `ArrivalConfirmed(tradeId, arrivalTimestamp)`: Arrival confirmed, 24h dispute window started
- `FinalTrancheReleased(tradeId, supplier, supplierSecondTranche)`: Final tranche released after dispute window
- `DisputeOpenedByBuyer(tradeId)`: Buyer opened dispute, trade frozen

**Dispute Events:**

- `DisputeSolutionProposed(proposalId, tradeId, disputeStatus, proposer)`: Admin proposed dispute solution
- `DisputeApproved(proposalId, approver, approvalCount, requiredApprovals)`: Admin approved dispute proposal
- `DisputeFinalized(proposalId, tradeId, disputeStatus)`: Dispute executed, funds distributed
- `DisputePayout(tradeId, proposalId, recipient, amount, payoutType)`: Explicit dispute payout recipient/amount by resolution type

**Governance Events:**

- `OracleUpdateProposed(proposalId, proposer, newOracle, eta, emergencyFastTrack)`: Oracle update proposed with timelock or emergency fast-track
- `OracleUpdateApproved(proposalId, approver, approvalCount, requiredApprovals)`: Admin approved oracle update
- `OracleUpdated(oldOracle, newOracle)`: Oracle address updated
- `AdminAddProposed(proposalId, proposer, newAdmin, eta)`: Admin addition proposed with timelock
- `AdminAddApproved(proposalId, approver, approvalCount, requiredApprovals)`: Admin approved admin addition
- `AdminAdded(newAdmin)`: New admin added to contract

**Emergency/Timeout/Recovery Events:**

- `Paused(by)`, `Unpaused(by)`, `OracleDisabledEmergency(by, previousOracle)`
- `UnpauseProposed(proposer)`, `UnpauseApproved(approver, approvalCount, requiredApprovals)`, `UnpauseProposalCancelled(cancelledBy)`
- `TradeCancelledAfterLockTimeout(tradeId, buyer, refundedAmount)`
- `InTransitTimeoutRefunded(tradeId, buyer, refundedAmount)`
- `DisputeProposalExpiredCancelled(proposalId, tradeId, cancelledBy)`
- `OracleUpdateProposalExpiredCancelled(proposalId, cancelledBy)`
- `AdminAddProposalExpiredCancelled(proposalId, cancelledBy)`

### Contract: `MockUSDC.sol`

ERC20 test token for local development and testing.

## Tests:

### Test Coverage Summary

Use commands below to get the current test counts and pass/fail status (counts evolve as tests are added):

```bash
# from contracts/
npm run test
npm run coverage
npm run test:foundry
```

---

### Hardhat Tests `AgroasysEscrow.ts`

Current suites include:

- `Deployment`
- `Emergency Controls`
- `Paused Matrix Hardening`
- `Timeout Escape Hatches`
- `Treasury Leakage Guards`
- `createTrade`
- `Complete Flow (Without dispute)`
- `releaseFundsStage1`
- `confirmArrival`
- `Dispute Flow`
- `Governance: Oracle Update`
- `Governance: Add Admin`
- `Expiry Edge Boundaries`

### Foundry Suites

- `foundry/test/AgroasysEscrowFuzz.t.sol`
- `foundry/test/AgroasysEscrowInvariant.t.sol`

## Scripts:

Deployment scripts for the 2 contracts in:

```
ignition
└── modules
    ├── AgroasysEscrow.ts
    └── MockUSDC.ts
```

## Set Up project

### Hardhat Config

```bash
cd contracts
npm install
```

### Foundry Config

```bash
cd foundry
forge install --no-git foundry-rs/forge-std
forge install --no-git OpenZeppelin/openzeppelin-contracts
forge build
```

## Running Tests

### Hardhat Unit Tests

```bash
npm run compile
npm run test
npm run coverage
```

### Foundry Fuzzing Tests

Requires `forge` in PATH.

```bash
# from contracts/
npm run test:foundry

# optional: targeted suites
cd foundry
forge test --match-contract FuzzTest -vvv
forge test --match-contract InvariantTest -vvv
```

## Deploy Contracts

```bash
npm run deploy:base-sepolia
npm run deploy:base-mainnet
```

Required deploy-time inputs:

- `DEPLOY_ORACLE_ADDRESS`
- `DEPLOY_TREASURY_ADDRESS`
- `DEPLOY_ADMINS` (comma-separated)
- `DEPLOY_REQUIRED_APPROVALS`

Optional deploy-time inputs:

- `DEPLOY_VERIFY=true|false`
- `DEPLOY_CONFIRMATIONS`
- `DEPLOY_EVIDENCE_OUT_DIR`
- `BASE_SEPOLIA_RPC_URL`
- `BASE_MAINNET_RPC_URL`
- `BASESCAN_API_KEY`

## Addresses

Deployment addresses are network/environment-specific.
Use Hardhat Ignition deployment output as the source of truth for the current environment.

## Scripts

Legacy runtime scripts under `contracts/scripts/` have been removed.
Use the SDK modules for operational execution paths instead:

- `sdk/src/modules/buyerSDK.ts`
- `sdk/src/modules/adminSDK.ts`
- `sdk/src/modules/oracleSDK.ts`

Run SDK smoke tests from repository root (workspace `sdk`):

```bash
npm -w sdk run test:buyer
npm -w sdk run test:admin
npm -w sdk run test:oracle
```

## License

Licensed under Apache-2.0.
See the repository root `LICENSE` file.
