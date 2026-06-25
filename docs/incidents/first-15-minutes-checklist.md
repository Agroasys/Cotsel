# Incident First 15 Minutes Checklist

1. Declare severity and incident commander.
2. Freeze risky automation if settlement correctness is uncertain.
3. Capture current service health:

```bash
scripts/cotsel.sh ps
scripts/cotsel.sh health
```

4. Capture key logs:

```bash
scripts/cotsel.sh logs oracle
scripts/cotsel.sh logs reconciliation
scripts/cotsel.sh logs treasury
scripts/cotsel.sh logs ricardian
```

5. Run release-gate diagnostics for the impacted profile:
   - `docs/runbooks/runtime-release-gate.md`
   - `docs/runbooks/runtime-release-gate.md`
   - For Base mainnet launch or rollback windows, also use:
     - `docs/runbooks/base-mainnet-go-no-go.md`
     - `docs/runbooks/base-mainnet-cutover-and-rollback.md`
6. Confirm whether issue is chain connectivity, indexer drift, auth failures, attestation/compliance-provider outage, or data-layer fault.
7. Start `docs/incidents/incident-evidence-template.md` and record affected trade IDs, action keys, request IDs, trace IDs, tx hashes, and attestation issuer/provider references when applicable.
8. Decide containment path (pause/disable/or continue with monitoring) and record the owner and timestamp in the template.
9. Link operator-reviewed evidence packets from `docs/runbooks/operator-audit-evidence-template.md` when recovery actions require approval or audit follow-up.
10. Notify stakeholders with current blast radius and next update time.

Launch-window rule:

- Do not improvise retired runtime rollback paths during a Base mainnet incident.
