# Base Sepolia evidence archive

## Purpose

This root creates the immutable evidence bucket, archive key, append-only writer, and CloudTrail trail.
The account-owner governance root creates the reader, audit log, alarm, topic, and CloudTrail delivery role.

Do not use this root for customer settlement, controlled-pilot intake, or Base mainnet evidence.

## Prerequisites

Before you create an archive plan, confirm these controls:

- The exact governance plan has independent approval.
- The account owner applied that exact plan.
- The plan, apply, writer, reader, and CloudTrail roles exist.
- The denied-mutation alarm has at least one confirmed alert recipient.
- The Cotsel `main` commit matches the reviewed source.

Stop if a prerequisite is absent or has a different identity.

## Apply sequence

1. Dispatch `.github/workflows/terraform.yml` from `main`.
2. Select `action=plan` and `root=base-sepolia-evidence-archive`.
3. Record the run ID, object version, plan SHA-256, source SHA, and complete change set.
4. Get independent approval for that exact plan.
5. Have a different person dispatch `action=apply` with the recorded run ID and object version.
6. Verify the bucket, key, writer, trail, log delivery, alarm, and topic against Terraform outputs.

Do not use owner break-glass for normal archive provisioning.

## Custody test

Use `.github/workflows/archive-base-sepolia-evidence.yml` after the archive apply succeeds.

1. Dispatch `write-denial-test` from `main` with the exact candidate ID.
2. Record the object key, version ID, SHA-256, source SHA, actor, and run ID.
3. Have a different actor dispatch `verify-custody` with those exact values.
4. Retain both workflow summaries and the alert receipt in the closure ledger.

The writer run must prove that read, delete, bypass, retention, and legal-hold actions fail.
The reader run must verify the exact version, hash, 90-day governance retention, CloudTrail events, and alert action.

Stop if the alert topic has no confirmed recipient. Stop if writer and reader actors are the same.
