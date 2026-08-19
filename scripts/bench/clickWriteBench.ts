import { randomUUID } from 'node:crypto';
import { pool, query } from '../../worker/db/pool.js';
import { processClickJob } from '../../worker/processors/clickProcessor.js';

const N = 1000;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  // Mix of hot/cold links: reuse a handful of real seeded link ids so the
  // benchmark's writes land on rows of realistic size/shape, not synthetic
  // ones the seed never created.
  const linkRows = await query<{ id: string }>(
    `(SELECT id FROM links ORDER BY click_count DESC LIMIT 5)
     UNION ALL
     (SELECT id FROM links ORDER BY click_count ASC LIMIT 5)
     UNION ALL
     (SELECT id FROM links ORDER BY random() LIMIT 20)`,
  );
  const linkIds = linkRows.rows.map((r) => r.id);

  const durations: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const linkId = linkIds[i % linkIds.length]!;
    const start = process.hrtime.bigint();
    await processClickJob({
      clickId: randomUUID(),
      linkId,
      shortCode: 'bench',
      referrer: 'https://bench.example.com',
      userAgent: 'bench/1.0',
    });
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    durations.push(durationMs);
  }

  durations.sort((a, b) => a - b);
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  console.log(
    JSON.stringify({
      n: N,
      p50Ms: Math.round(percentile(durations, 50) * 1000) / 1000,
      p95Ms: Math.round(percentile(durations, 95) * 1000) / 1000,
      meanMs: Math.round(mean * 1000) / 1000,
      maxMs: Math.round(durations[durations.length - 1]! * 1000) / 1000,
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
