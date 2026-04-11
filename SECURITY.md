# Security Policy

## Supported Versions

The project follows a rolling support model.

| Version branch                        | Supported |
| ------------------------------------- | --------- |
| `main`                                | Yes       |
| release tags older than current cycle | No        |

## Reporting a Vulnerability

Please do not open public GitHub issues for security vulnerabilities.

Report privately to: `security@agroasys.com`

Include:

- affected workspace/module
- severity and impact
- reproducible steps or proof of concept
- proposed mitigation (if available)

We will acknowledge receipt and provide triage status as soon as possible.

## Triage Notes

Some transitive dependency advisories may have no upstream fix available yet.
In those cases we track exposure and mitigation options (pinning, compensating controls, or replacing dependency) until a safe update path is available.
