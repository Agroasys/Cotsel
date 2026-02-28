# Treasury-to-Fiat SOP

## Purpose
Define a controlled, auditable procedure to move treasury-observed settlement value into fiat rails without bypassing payout controls.

## Who This Is For
- `Treasury Operator`: prepares payout package and executes approved transfer.
- `Treasury Approver`: validates controls and authorizes payout progression.
- `Compliance Reviewer`: verifies audit completeness and exception handling.
- `On-call Engineer`: supports technical remediation when service paths fail.

## When To Use
- Stage-1 treasury components are ready for payout processing.
- Pilot/staging exercises that require operational evidence for fiat settlement path.

## Scope
- Treasury ledger state progression (`PENDING_REVIEW` -> `READY_FOR_PAYOUT` -> `PROCESSING` -> `PAID` or `CANCELLED`).
- Approval and evidence requirements for treasury-to-fiat execution.
- Exception handling for failed, incorrect, or partial payouts.

## Non-Scope
- Contract-level release logic or dispute governance.
- External bank/exchange onboarding contracts or legal policy text.
- UI workflow implementation.

## Prerequisites
- Treasury service is healthy:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/ready"
```

- Ledger entries are present from indexed stage-1 events (`FundsReleasedStage1`, `PlatformFeesPaidStage1`).
- Service auth headers available when `TREASURY_AUTH_ENABLED=true`.
- Approval separation is active:
  - Treasury Operator cannot self-approve their own payout request.
- Escrow treasury model is understood:
  - `treasuryAddress` is immutable signed identity.
  - `treasuryPayoutAddress` is rotatable payout destination.
  - Treasury entitlement accrues to `claimableUsdc[treasuryAddress]` and is paid by `claimTreasury()`.

If `TREASURY_AUTH_ENABLED=true`, include required HMAC headers on every treasury API call.
Required headers:
- `x-agroasys-timestamp`
- `x-agroasys-signature`
- `x-agroasys-nonce` (optional)
- `X-Api-Key` (when key-based auth is used)

## Safety Guardrails
- Never execute payout without an approved ledger entry and evidence package.
- Never skip payout state transitions or force `PAID` directly.
- Never log secrets, private keys, or full credentialed webhook URLs.
- Never continue processing when destination details are ambiguous.
- Never use an arbitrary payout destination for treasury claim execution; destination is contract-controlled.

## Procedure

### 0. Sweep treasury entitlement on-chain (destination-locked)
Before preparing fiat payout records, move treasury claimable value from escrow to the active payout receiver:

```bash
cast send <ESCROW_ADDRESS> "claimTreasury()" --private-key "$OPS_TRIGGER_KEY"
```

AdminSDK equivalent (same destination-locked behavior):

```ts
const adminSDK = new AdminSDK({ rpc, chainId, escrowAddress, usdcAddress });
await adminSDK.claimTreasury(triggerSigner);
```

Verification:

```bash
cast call <ESCROW_ADDRESS> "claimableUsdc(address)(uint256)" <TREASURY_IDENTITY_ADDRESS>
cast call <ESCROW_ADDRESS> "treasuryPayoutAddress()(address)"
```

Expected:
- `claimableUsdc(treasuryAddress)` decreases to `0` for swept amount.
- `TreasuryClaimed` event exists with:
  - immutable `treasuryIdentity`
  - destination equal to current `treasuryPayoutAddress`
  - `triggeredBy` matching caller address.

### 1. Build payout candidate list
Fetch entries for review:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries?state=PENDING_REVIEW&limit=100&offset=0"
```

Expected result:
- Candidate entries include `trade_id`, `tx_hash`, `component_type`, `amount_raw`, and `latest_state`.

If not:
- Run ingestion once and retry listing:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/ingest"
```

### 2. Control checklist before approval
For each candidate entry, confirm:
- Destination account details match approved beneficiary record.
- Payout purpose links to the correct `trade_id` and settlement component.
- Amount/currency alignment with ledger record.
- Required approvals are collected (operator + independent approver).

Expected result:
- Entry is either approved for payout or rejected with a documented reason.

If not:
- Mark entry `CANCELLED` with reason and stop payout path for that entry.

### 3. Move approved entry to `READY_FOR_PAYOUT`
Append state transition:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries/<entry-id>/state" \
  -H "Content-Type: application/json" \
  -d '{"state":"READY_FOR_PAYOUT","note":"Approved for treasury-to-fiat execution","actor":"Treasury Approver"}'
```

Expected result:
- Response is `success: true`; transition is accepted by state machine rules.

If not:
- Validate current state and transition legality against state machine rules in `treasury/src/core/payout.ts` (source of truth for validation behavior).
- Do not continue until transition path is valid.

### 4. Start fiat transfer execution (`PROCESSING`)
Record start of execution window:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries/<entry-id>/state" \
  -H "Content-Type: application/json" \
  -d '{"state":"PROCESSING","note":"Transfer initiated with approved off-ramp","actor":"Treasury Operator"}'
```

Execute transfer in approved off-ramp channel (bank/exchange workflow).

Expected result:
- External transfer reference is generated.

If not:
- Append `CANCELLED` if transfer cannot be safely executed and record reason.

### 5. Finalize entry (`PAID`) and attach evidence
After transfer confirmation:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries/<entry-id>/state" \
  -H "Content-Type: application/json" \
  -d '{"state":"PAID","note":"Transfer settled; receipt and FX evidence attached","actor":"Treasury Operator"}'
```

Record post-transfer evidence:
- Transfer reference/receipt ID.
- FX rate and timestamp used for conversion.
- Linked `trade_id`, ledger `entry_id`, and source on-chain `tx_hash`.

Expected result:
- Entry appears with `latest_state=PAID`.

If not:
- Keep entry in `PROCESSING`, investigate with approver + on-call engineer, and avoid duplicate transfer attempts.

## Evidence To Record (Audit Minimum)
- Actor for every state transition and approval timestamp.
- Payout destination validation result.
- Amount/currency checks and approval artifacts.
- Off-ramp transfer reference, FX rate, and settlement timestamp.
- Associated `trade_id`, `entry_id`, `tx_hash`, incident/ticket IDs (if any).

## Exception Handling

### Treasury payout receiver incident (compromise/lost key/freeze)
1. Freeze claim path:

```bash
cast send <ESCROW_ADDRESS> "pauseClaims()" --private-key "$ADMIN_KEY"
```

2. Rotate payout receiver through governance:

```bash
cast send <ESCROW_ADDRESS> "proposeTreasuryPayoutAddressUpdate(address)" <NEW_RECEIVER> --private-key "$ADMIN1_KEY"
cast send <ESCROW_ADDRESS> "approveTreasuryPayoutAddressUpdate(uint256)" <PROPOSAL_ID> --private-key "$ADMIN2_KEY"
# wait governance timelock
cast send <ESCROW_ADDRESS> "executeTreasuryPayoutAddressUpdate(uint256)" <PROPOSAL_ID> --private-key "$ADMIN1_KEY"
```

AdminSDK equivalent:

```ts
const proposal = await adminSDK.proposeTreasuryPayoutAddressUpdate(newReceiver, admin1Signer);
await adminSDK.approveTreasuryPayoutAddressUpdate(proposal.proposalId!, admin2Signer);
// wait governance timelock
await adminSDK.executeTreasuryPayoutAddressUpdate(proposal.proposalId!, admin1Signer);
```

3. Verify receiver and unfreeze:

```bash
cast call <ESCROW_ADDRESS> "treasuryPayoutAddress()(address)"
cast send <ESCROW_ADDRESS> "unpauseClaims()" --private-key "$ADMIN_KEY"
```

### Wrong destination submitted
- Stop immediately; do not execute transfer.
- Mark entry `CANCELLED` with explicit reason.
- Escalate to compliance reviewer and on-call engineer.

### Off-ramp transfer failed
- Keep state at `PROCESSING` only while active retry plan exists.
- If transfer cannot recover safely, set `CANCELLED` and open incident.

### Partial settlement confirmed
- Do not mark `PAID` until full amount is reconciled.
- Record partial receipt and discrepancy details.
- Escalate for controlled remediation and evidence review.

## Rollback / Escalation
1. Pause payout progression for impacted entries.
2. Capture treasury API responses, logs, and transfer references.
3. Run `docs/incidents/first-15-minutes-checklist.md` for high-risk incidents.
4. Escalate with full evidence to Treasury Approver, Compliance Reviewer, and On-call Engineer.

## Migration Notes (Non-Upgradeable Escrow)
- Legacy escrow instances may still hold treasury claimables during transition.
- Treasury operations must drain old escrow balances before sunsetting legacy monitoring.
- Maintain dual-tracking until all are true:
  - all legacy escrows have `claimableUsdc(treasuryAddress) == 0`
  - all expected `TreasuryClaimed` events are reconciled to payout ledger entries (verify via `scripts/staging-e2e-real-gate.sh` and `docs/runbooks/reconciliation.md#treasury-sweep-reconciliation-invariants`)
  - no pending treasury payout rotation incidents remain open

## Related References
- `treasury/README.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/hybrid-split-walkthrough.md`
- `docs/runbooks/oracle-redrive.md`
