const path = require('node:path');
const DefaultSequencer = require('@jest/test-sequencer').default;

class IntegrationTestSequencer extends DefaultSequencer {
  sort(tests) {
    const sorted = super.sort(tests);
    const priorityFiles = ['page-snapshots.test.js', 'listing-search.test.js'];
    const prioritized = [];
    for (const fileName of priorityFiles) {
      const index = sorted.findIndex(({ path: testPath }) => path.basename(testPath) === fileName);
      if (index >= 0) prioritized.push(...sorted.splice(index, 1));
    }
    return [...prioritized, ...sorted];
  }
}

module.exports = IntegrationTestSequencer;
