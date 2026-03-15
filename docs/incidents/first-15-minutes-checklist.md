# Incident First 15 Minutes Checklist

1. Declare severity and incident commander.
2. Freeze risky automation if settlement correctness is uncertain.
3. Capture current service health:

```bash
scripts/docker-services.sh ps local-dev
scripts/docker-services.sh health local-dev
```

4. Capture key logs:

```bash
scripts/docker-services.sh logs local-dev oracle
scripts/docker-services.sh logs local-dev reconciliation
scripts/docker-services.sh logs local-dev treasury
scripts/docker-services.sh logs local-dev ricardian
```

5. Run release-gate diagnostics for the impacted profile:
   - `docs/runbooks/staging-e2e-release-gate.md`
   - `docs/runbooks/staging-e2e-real-release-gate.md`
6. Confirm whether issue is chain connectivity, indexer drift, auth failures, or data-layer fault.
7. Start `docs/incidents/incident-evidence-template.md` and record affected trade IDs, action keys, request IDs, trace IDs, and tx hashes.
8. Decide containment path (pause/disable/or continue with monitoring) and record the owner and timestamp in the template.
9. Link operator-reviewed evidence packets from `docs/runbooks/operator-audit-evidence-template.md` when recovery actions require approval or audit follow-up.
10. Notify stakeholders with current blast radius and next update time.
