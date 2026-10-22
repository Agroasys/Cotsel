/** SPDX-License-Identifier: Apache-2.0 */
// Explicit paired-only composition of the retained mapping and supported finalized-only database mode.
if (
  process.env.COTSEL_PAIRED_LIFECYCLE_FIXTURE !== 'true' ||
  process.env.DB_HOST !== '127.0.0.1' ||
  !process.env.DB_NAME?.startsWith('rev2_indexer_')
)
  process.exit(2);
const { TypeormDatabase } = require('@subsquid/typeorm-store');
const { bootstrap } = require('../lib/main');
void bootstrap(
  new TypeormDatabase({ initializeStateSchema: false, supportHotBlocks: false }),
).catch((error) => {
  process.stderr.write(String(error.stack) + '\n');
  process.exit(1);
});
