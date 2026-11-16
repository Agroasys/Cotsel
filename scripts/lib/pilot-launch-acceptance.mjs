/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Acceptance-record rules for the pilot launch profile (issue #613). A profile may gate a
 * promotion only with a recorded decision naming who accepted it, when, for which candidate
 * commit and where the decision is recorded.
 */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A recorded decision: an issue or PR comment, or a PR review, in an Agroasys repository.
export const DECISION_EVIDENCE_PATTERN =
  /^https:\/\/github\.com\/Agroasys\/[A-Za-z0-9.-]+\/(?:issues|pull)\/[0-9]+#(?:issuecomment|pullrequestreview)-[0-9]+$/;

function approvalHolders(authorityRegistry, authorityProfileId) {
  const authority = authorityRegistry?.profiles?.find(
    (entry) => entry.profileId === authorityProfileId,
  );
  return new Set(
    Object.values(authority?.approvalRoles ?? {})
      .filter((login) => typeof login === 'string')
      .map((login) => login.toLowerCase()),
  );
}

/**
 * An accepted profile must carry the decision that accepted it: who, when, for which candidate
 * commit and where it is recorded. Only a named approval-role holder of the release authority
 * profile may accept. A profile that is not accepted must not carry a stale acceptance block.
 */
export function validateAcceptance(c, profile, authorityRegistry) {
  if (profile.status !== 'accepted') {
    if (profile.acceptance !== undefined) {
      c.add('acceptance', 'is allowed only when status is accepted');
    }
    return;
  }
  const acceptance = profile.acceptance;
  if (acceptance === null || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    c.add('acceptance', 'is required when status is accepted');
    return;
  }
  c.equal(acceptance.decision, 'ACCEPTED', 'acceptance.decision', 'an acceptance record');
  c.pattern(acceptance.acceptedBy, GITHUB_LOGIN_PATTERN, 'acceptance.acceptedBy', 'a GitHub login');
  c.pattern(acceptance.acceptedAt, TIMESTAMP_PATTERN, 'acceptance.acceptedAt', 'a UTC timestamp');
  c.pattern(
    acceptance.candidateCommit,
    COMMIT_PATTERN,
    'acceptance.candidateCommit',
    'the full 40-character commit of the accepted candidate',
  );
  c.pattern(
    acceptance.evidence,
    DECISION_EVIDENCE_PATTERN,
    'acceptance.evidence',
    'a link to the recorded acceptance comment or review',
  );
  const holders = approvalHolders(authorityRegistry, profile.release?.authorityProfileId);
  if (
    typeof acceptance.acceptedBy === 'string' &&
    !holders.has(acceptance.acceptedBy.toLowerCase())
  ) {
    c.add('acceptance.acceptedBy', 'must be a named approval-role holder of the release authority');
  }
}
