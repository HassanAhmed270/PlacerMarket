/**
 * Enforces rules.md Section 3: no circular requires between
 * modules/*.service.js files.
 *
 * Static check (reads the source and follows `require('./x.service')`
 * calls) rather than a runtime check, because Node silently tolerates
 * cycles at runtime by handing back a partially-populated exports object —
 * which is exactly how this kind of bug stays hidden until a function is
 * called and turns out to be undefined.
 */

const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', '..', 'src', 'modules');
const REQUIRE_PATTERN = /require\(\s*['"]\.\/([\w-]+\.service)['"]\s*\)/g;

function buildGraph(dir) {
  const graph = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.service.js'))) {
    const name = file.replace(/\.js$/, '');
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    graph[name] = [...source.matchAll(REQUIRE_PATTERN)].map((m) => m[1]);
  }
  return graph;
}

/** Returns the first cycle found as an array of names (e.g. ['a','b','a']), or null. */
function findCycle(graph) {
  const visiting = new Set();
  const done = new Set();

  function visit(node, trail) {
    if (done.has(node)) return null;
    if (visiting.has(node)) return [...trail.slice(trail.indexOf(node)), node];
    visiting.add(node);
    for (const dep of graph[node] || []) {
      const cycle = visit(dep, [...trail, node]);
      if (cycle) return cycle;
    }
    visiting.delete(node);
    done.add(node);
    return null;
  }

  for (const node of Object.keys(graph)) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

describe('rules.md Section 3: no circular requires between modules/*.service.js', () => {
  test('the real module graph has no cycle', () => {
    const cycle = findCycle(buildGraph(MODULES_DIR));
    expect(cycle && cycle.join(' -> ')).toBeNull();
  });

  test('the detector itself works (sanity check on a known cyclic graph)', () => {
    const cycle = findCycle({ a: ['b'], b: ['c'], c: ['a'] });
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
  });

  test('the detector does not false-positive on a diamond (shared dependency, no cycle)', () => {
    expect(findCycle({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })).toBeNull();
  });
});
