import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pruneOldest } from '../retention';

describe('pruneOldest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcx-retention-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * Write files oldest-first, stamping increasing mtimes so ordering is
   * deterministic without sleeping between writes.
   */
  async function write(...names: string[]): Promise<void> {
    let when = new Date('2026-01-01T00:00:00Z').getTime();
    for (const name of names) {
      const file = path.join(dir, name);
      await fs.writeFile(file, 'x', 'utf8');
      when += 60_000;
      await fs.utimes(file, new Date(when), new Date(when));
    }
  }

  async function remaining(): Promise<string[]> {
    return (await fs.readdir(dir)).sort();
  }

  it('keeps the newest N and deletes the rest', async () => {
    await write(
      'cleanup-report-cleanup-2026-01-01T00-00-00-000Z.json',
      'cleanup-report-cleanup-2026-02-01T00-00-00-000Z.json',
      'cleanup-report-cleanup-2026-03-01T00-00-00-000Z.json',
      'cleanup-report-cleanup-2026-04-01T00-00-00-000Z.json'
    );

    const deleted = await pruneOldest(dir, 'cleanup-report-', 2);

    expect(deleted).toHaveLength(2);
    expect(await remaining()).toEqual([
      'cleanup-report-cleanup-2026-03-01T00-00-00-000Z.json',
      'cleanup-report-cleanup-2026-04-01T00-00-00-000Z.json'
    ]);
  });

  it('orders by age, not by name, when modes are mixed', async () => {
    // "cleanup" sorts before "dry-run" alphabetically, so a name sort would
    // delete the newest cleanup report as soon as two dry-run reports existed.
    await write(
      'cleanup-report-dry-run-2026-01-01T00-00-00-000Z.json',
      'cleanup-report-dry-run-2026-01-02T00-00-00-000Z.json',
      'cleanup-report-cleanup-2026-01-03T00-00-00-000Z.json'
    );

    await pruneOldest(dir, 'cleanup-report-', 1);

    expect(await remaining()).toEqual([
      'cleanup-report-cleanup-2026-01-03T00-00-00-000Z.json'
    ]);
  });

  it('leaves files alone when the count is at or under the limit', async () => {
    await write('cleanup-report-a.json', 'cleanup-report-b.json');

    expect(await pruneOldest(dir, 'cleanup-report-', 2)).toEqual([]);
    expect(await remaining()).toHaveLength(2);
  });

  it('only touches files matching the prefix', async () => {
    await write(
      'cleanup-report-1.json', 'cleanup-report-2.json', 'cleanup-report-3.json',
      'cleanup-summary-1.txt', 'cleanup.log', 'cleanup-error.log'
    );

    await pruneOldest(dir, 'cleanup-report-', 1);

    // The live logs and the summary pair must survive a report prune —
    // winston owns the .log rotation and summaries are pruned separately.
    expect(await remaining()).toEqual([
      'cleanup-error.log',
      'cleanup-report-3.json',
      'cleanup-summary-1.txt',
      'cleanup.log'
    ]);
  });

  it('prunes report and summary series independently', async () => {
    await write(
      'cleanup-report-1.json', 'cleanup-report-2.json',
      'cleanup-summary-1.txt', 'cleanup-summary-2.txt'
    );

    await pruneOldest(dir, 'cleanup-report-', 1);
    await pruneOldest(dir, 'cleanup-summary-', 1);

    expect(await remaining()).toEqual(['cleanup-report-2.json', 'cleanup-summary-2.txt']);
  });

  it('does nothing for a non-existent directory rather than throwing', async () => {
    // A first run prunes before anything has been written.
    await expect(pruneOldest(path.join(dir, 'nope'), 'cleanup-', 5)).resolves.toEqual([]);
  });

  it('treats a keep count below 1 as "no retention policy", not "delete everything"', async () => {
    await write('cleanup-report-1.json', 'cleanup-report-2.json');

    expect(await pruneOldest(dir, 'cleanup-report-', 0)).toEqual([]);
    expect(await pruneOldest(dir, 'cleanup-report-', -3)).toEqual([]);
    expect(await pruneOldest(dir, 'cleanup-report-', NaN)).toEqual([]);
    expect(await remaining()).toHaveLength(2);
  });
});
