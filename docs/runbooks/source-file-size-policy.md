# Source file size policy

## Purpose

This policy keeps hand-written code reviewable and prevents large modules from
growing without a deliberate refactor.

## Required limit

Keep each tracked source file at or below 500 physical lines.

The CI check applies to application source, tests, scripts, infrastructure code,
SQL, Solidity, and GitHub Actions workflows.

Generated outputs, lockfiles, generated API specifications, and synchronized
tooling mirrors are excluded. Review the canonical source that produces or owns
each excluded file.

## Existing oversized files

The repository contains legacy files above 500 lines. The file
`config/source-line-limit.json` records their current line counts.

CI applies these rules:

1. A new source file must not exceed 500 lines.
2. A legacy oversized file must not exceed its recorded baseline.
3. Remove the baseline entry when a file is reduced to 500 lines or fewer.
4. Do not increase a baseline to make CI pass.

The baseline is a debt register. It is not an exception for new growth.

## Verification

Run this command before you open a pull request:

```bash
pnpm run quality:file-size:check
```

If the check fails, split the file by responsibility. Keep security boundaries,
transaction behavior, and public interfaces unchanged unless the pull request
explicitly changes them.
