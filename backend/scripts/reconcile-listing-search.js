const listingSearch = require('../src/modules/listingSearch.service');
const queue = require('../src/lib/queue');
const { pool } = require('../src/db.service');

async function main() {
  await queue.startProducer();
  const result = await listingSearch.reconcileListingSearch();
  console.log(`Listing search reconciliation complete (${result.enqueued} jobs enqueued).`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Listing search reconciliation failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await queue.stopProducer();
      } finally {
        await pool.end();
      }
    });
}

module.exports = { main };
