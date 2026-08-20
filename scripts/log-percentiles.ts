import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A lightweight, local way to look at aggregate request latency without
 * standing up real metrics infrastructure. This is NOT distributed
 * tracing (no span/trace propagation across the click-recording queue ->
 * worker boundary) and NOT a real metrics backend (nothing here is
 * scraped, alerted on, or persisted beyond the log file itself) — see
 * Notes.md, "Phase 14a: Observability & API Documentation" for what a
 * real production setup (Prometheus/Grafana, or a hosted APM) would add
 * instead.
 *
 * Only works against Pino's native NDJSON output. In NODE_ENV=development,
 * src/lib/logger.ts applies a pino-pretty transport that produces
 * colorized, non-JSON text — run this against production-style output
 * (or NODE_ENV=production/test logs) instead.
 */

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank method: sorts a copy of the input and picks the value at
 * floor((p/100) * length), clamped to the last index. Matches the
 * percentile helper already used in scripts/bench/clickWriteBench.ts —
 * documented explicitly here because nearest-rank and interpolation
 * methods produce different exact numbers for the same input.
 */
export function computePercentiles(durations: number[]): Percentiles {
  if (durations.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  };

  return { count: sorted.length, p50: pick(50), p95: pick(95), p99: pick(99) };
}

interface RequestCompletedLine {
  method: string;
  route: string;
  durationMs: number;
}

function parseLine(line: string): RequestCompletedLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (
    record.msg !== 'Request completed' ||
    typeof record.method !== 'string' ||
    typeof record.route !== 'string' ||
    typeof record.durationMs !== 'number'
  ) {
    return null;
  }

  return { method: record.method, route: record.route, durationMs: record.durationMs };
}

/**
 * Groups "Request completed" log lines by "METHOD route" (the
 * cardinality-safe route pattern, not the raw path — see
 * src/middleware/requestContext.ts). Non-matching or non-JSON lines
 * (pino-pretty output, unrelated log lines) are silently skipped.
 */
export function groupDurationsByRoute(lines: string[]): Map<string, number[]> {
  const grouped = new Map<string, number[]>();

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    const key = `${parsed.method} ${parsed.route}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(parsed.durationMs);
    } else {
      grouped.set(key, [parsed.durationMs]);
    }
  }

  return grouped;
}

function printTable(grouped: Map<string, number[]>): void {
  if (grouped.size === 0) {
    console.log('No "Request completed" lines found in input.');
    return;
  }

  const rows = [...grouped.entries()]
    .map(([route, durations]) => ({ route, ...computePercentiles(durations) }))
    .sort((a, b) => b.p95 - a.p95);

  const header = ['route', 'count', 'p50ms', 'p95ms', 'p99ms'];
  const widths = header.map((h) => h.length);
  const formatted = rows.map((r) => [
    r.route,
    String(r.count),
    r.p50.toFixed(1),
    r.p95.toFixed(1),
    r.p99.toFixed(1),
  ]);
  for (const row of formatted) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i]!, cell.length);
    });
  }

  const printRow = (cells: string[]): void => {
    console.log(cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  };

  printRow(header);
  printRow(widths.map((w) => '-'.repeat(w)));
  for (const row of formatted) printRow(row);
}

async function readLines(source: string | undefined): Promise<string[]> {
  const stream = source ? createReadStream(source, 'utf-8') : process.stdin;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) {
    if (line.trim().length > 0) lines.push(line);
  }
  return lines;
}

async function main(): Promise<void> {
  const source = process.argv[2];
  const lines = await readLines(source);
  const grouped = groupDurationsByRoute(lines);
  printTable(grouped);
}

// Only run when executed directly (`tsx scripts/log-percentiles.ts`), not
// when imported by tests/scripts/logPercentiles.test.ts for the pure
// functions above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('Failed to compute log percentiles:', err);
    process.exit(1);
  });
}
