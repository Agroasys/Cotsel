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
