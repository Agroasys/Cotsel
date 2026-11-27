#!/usr/bin/env bash
set -euo pipefail

{
  printf '%s\n\n' '### Terraform apply attempt'
  printf '%s\n' '| Field | Value |'
  printf '%s\n' '| --- | --- |'
  printf '| Result | `%s` |\n' "$APPLY_RESULT"
  printf '| Root | `%s` |\n' "$ROOT"
  printf '| Commit | `%s` |\n' "$GITHUB_SHA"
  printf '| Plan run | `%s` |\n' "$PLAN_RUN_ID"
  printf '| Plan version | `%s` |\n' "$PLAN_VERSION_ID"
  printf '| Applied by | `%s` |\n' "$GITHUB_TRIGGERING_ACTOR"
  printf '| Owner break-glass | `%s` |\n' "$BREAK_GLASS"
  if test "$BREAK_GLASS" = "true"; then
    printf '| Break-glass reason | `%s` |\n' "$OWNER_BREAK_GLASS_REASON"
  fi
} >> "$GITHUB_STEP_SUMMARY"
