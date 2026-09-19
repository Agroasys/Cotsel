/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Eligibility now consults ingestion freshness before it judges any entry, so
 * a suite about one entry's own evidence has to say that the feed behind it is
 * current -- otherwise every case would block for a reason it is not testing.
 * Suites about the freshness gate itself inject their own assessment instead.
 */
import { TreasuryEligibilityService } from '../../src/core/exportEligibility';
import { freshIngestion } from './ingestionFreshness';

type EligibilityDeps = NonNullable<ConstructorParameters<typeof TreasuryEligibilityService>[0]>;

export function eligibilityServiceWithFreshIngestion(
  deps: EligibilityDeps,
): TreasuryEligibilityService {
  return new TreasuryEligibilityService({ ingestionFreshness: freshIngestion(), ...deps });
}
