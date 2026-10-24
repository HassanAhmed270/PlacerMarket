const listingSearch = require('../src/modules/listingSearch.service');
const { pool } = require('../src/db.service');

async function main() {
  const result = await listingSearch.rebuildListingSearch();
  console.log(`Listing search rebuild complete (${result.indexed} listings indexed).`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Listing search rebuild failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { main };
