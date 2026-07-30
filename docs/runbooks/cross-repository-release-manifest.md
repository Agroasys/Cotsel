# Cross-repository release manifest

The Integration Lead is the single accountable owner of the Cotsel cross-repository release manifest. The manifest pins the exact Agroasys backend, platform.v1 and Cotsel-Dash commits used with the Cotsel workflow commit and pins the settlement callback contract versions. Repository owners may propose a pin change, but they may not approve an incompatible combination independently.

`integration/release-manifest.json` is checked in as `candidate`, not as evidence of production approval. It pins the locally verified Agroasys backend, platform.v1 and Cotsel-Dash commits. Draft and baseline manifests cannot supply workflow checkout outputs. Any repository change requires the Integration Lead to update the corresponding full commit SHA and return the manifest to `candidate`. The hosted compatibility workflow then verifies clean checkouts at those exact commits, compares the Cotsel and Agroasys callback fixtures, runs the Agroasys backend provider contracts, runs the platform.v1 consumer contracts, runs the Cotsel settlement provider contract, and executes the M3 backend/gateway/Cotsel-Dash continuity suite. The result is attached to the release record. Status may change to `approved` only after those checks and the remaining SOW release gates pass for the exact pinned commits.

Run the local structural check with:

```bash
pnpm run integration:manifest:check
```

To verify checked-out sibling repositories as well, set `AGROASYS_BACKEND_REPO_DIR`, `PLATFORM_V1_REPO_DIR` and `COTSEL_DASH_REPO_DIR` to the three checkout directories and run:

```bash
node scripts/check-cross-repo-release-manifest.mjs --verify-checkouts
```

The hosted workflow requires an organization or repository secret named `CROSS_REPO_CHECKOUT_TOKEN` with read-only contents access to the three private sibling repositories and read-package access to the private `@agroasys/sdk` package consumed by Cotsel-Dash. The credential must not have write, administration or workflow authority. The workflow is intentionally manual until that credential is provisioned and the first green evidence run is reviewed. After that, the Release Owner must add the workflow as an automatic pull-request and protected-environment promotion gate; it must not be represented as active while the credential is absent.
