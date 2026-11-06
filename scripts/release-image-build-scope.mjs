import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// These issue-governance tools are not copied into or executed by any release image.
// Unknown paths, including this classifier and Docker/workflow changes, require builds.
const issueOnlyPaths = new Set([
  'scripts/readiness/render-cotsel-production-readiness-issue.mjs',
  'scripts/readiness/validate-cotsel-production-readiness.mjs',
]);

export function releaseImageBuildRequired(eventName, changedPaths) {
  return (
    eventName !== 'pull_request' ||
    changedPaths.length === 0 ||
    changedPaths.some((path) => !issueOnlyPaths.has(path))
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, 'utf8').split('\0');
  if (paths.at(-1) === '') paths.pop();
  console.log(`build_required=${releaseImageBuildRequired(process.env.GITHUB_EVENT_NAME, paths)}`);
}
