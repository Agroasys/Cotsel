import { createHash } from 'node:crypto';

export function matchesVerifiedDisposition(advisory, disposition) {
  if (!disposition) return false;
  const versions = (advisory.findings ?? []).map((finding) => finding.version);
  return (
    advisory.module_name === disposition.moduleName &&
    advisory.severity === disposition.severity &&
    advisory.patched_versions === disposition.patchedVersions &&
    (!disposition.vulnerableVersions ||
      advisory.vulnerable_versions === disposition.vulnerableVersions) &&
    (!disposition.overviewHash ||
      createHash('sha256')
        .update(advisory.overview ?? '')
        .digest('hex') === disposition.overviewHash) &&
    versions.length > 0 &&
    versions.every((version) => disposition.versions.has(version))
  );
}

/** Longest a production disposition may run before it must be reviewed again. */
export const MAX_PRODUCTION_DISPOSITION_DAYS = 90;

/**
 * A production disposition is stricter than a development one: on top of the
 * exact advisory match, every finding must sit on a reviewed dependency path,
 * and the disposition expires so it is reassessed even if nothing else changes.
 * It exists only for advisories with no upstream release, where the repository
 * ships a tested local fix. Returns a reason string, or undefined when accepted.
 */
export function productionDispositionFailure(advisory, disposition, now = new Date()) {
  if (!disposition) return 'no production disposition exists';
  for (const field of [
    'overviewHash',
    'vulnerableVersions',
    'patchFile',
    'dispositionDocument',
    'owner',
  ]) {
    if (!disposition[field]) return `production disposition is missing ${field}`;
  }
  if (!matchesVerifiedDisposition(advisory, disposition)) {
    return 'advisory metadata does not match the reviewed production disposition';
  }
  const expiresAt = Date.parse(`${disposition.expiresOn}T23:59:59Z`);
  if (!Number.isFinite(expiresAt)) return 'production disposition has no valid expiry date';
  if (now.getTime() > expiresAt) {
    return `production disposition expired on ${disposition.expiresOn}`;
  }
  if (expiresAt - now.getTime() > MAX_PRODUCTION_DISPOSITION_DAYS * 86_400_000) {
    return `production disposition expiry is more than ${MAX_PRODUCTION_DISPOSITION_DAYS} days ahead`;
  }
  const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
  if (paths.length === 0 || paths.some((entry) => !disposition.paths.has(entry))) {
    return 'a finding is on a dependency path outside the reviewed production disposition';
  }
  return undefined;
}
