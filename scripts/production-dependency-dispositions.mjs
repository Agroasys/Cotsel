// SPDX-License-Identifier: Apache-2.0
// Reviewed production dependency dispositions, shared by the dependency gate
// (scripts/security-deps-gate.mjs) and the release-image Trivy exceptions
// (config/trivy/release-image-ignore.yaml) so both expire on the same date.
//
// Production advisories fail the gate unless listed here. This is a last
// resort, allowed only when no upstream release fixes the advisory and the
// repository ships a tested local fix. See
// the "Production exceptions" section of
// docs/security/dependency-vuln-policy.md for the rules.
//
// Entry shape, keyed by GitHub advisory id:
//   moduleName, severity, vulnerableVersions, patchedVersions,
//   overviewHash        SHA-256 of the advisory overview text
//   versions            Set of exact installed versions
//   paths               Set of exact production dependency paths
//   patchFile           the tested local fix
//   expiresOn           YYYY-MM-DD, at most 90 days ahead
//   trivyId             optional; requires a matching Trivy exception
//   dispositionDocument the reviewed disposition record
//   owner               accountable owner of the release risk
export const verifiedProductionDispositions = new Map();
