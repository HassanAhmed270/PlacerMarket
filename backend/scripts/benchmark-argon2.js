const argon2 = require('argon2');

const targetMs = Number(process.env.ARGON2_BENCHMARK_TARGET_MS || 250);
const repeats = Number(process.env.ARGON2_BENCHMARK_REPEATS || 3);
const profiles = [
  { memoryCost: 32768, timeCost: 2, parallelism: 1 },
  { memoryCost: 65536, timeCost: 2, parallelism: 1 },
  { memoryCost: 65536, timeCost: 3, parallelism: 1 },
  { memoryCost: 98304, timeCost: 2, parallelism: 1 },
  { memoryCost: 98304, timeCost: 3, parallelism: 1 },
];

function median(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

async function main() {
  if (!Number.isFinite(targetMs) || targetMs <= 0 || !Number.isSafeInteger(repeats) || repeats < 1) {
    throw new Error('ARGON2_BENCHMARK_TARGET_MS and ARGON2_BENCHMARK_REPEATS must be positive numbers.');
  }
  const results = [];
  for (const profile of profiles) {
    const timings = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const started = performance.now();
      await argon2.hash('benchmark-only-credential', { type: argon2.argon2id, ...profile });
      timings.push(Math.round(performance.now() - started));
    }
    results.push({ ...profile, medianMs: median(timings), timingsMs: timings });
  }
  const eligible = results.filter((result) => result.medianMs <= targetMs);
  const selected = eligible.sort((left, right) =>
    (right.memoryCost * right.timeCost) - (left.memoryCost * left.timeCost)
  )[0] || results[0];
  process.stdout.write(`${JSON.stringify({ targetMs, repeats, selected, results }, null, 2)}\n`);
}

main().catch(() => {
  process.stderr.write('Argon2 benchmark failed. No password or hash was written.\n');
  process.exitCode = 1;
});
