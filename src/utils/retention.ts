import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Keep the newest `keep` files matching `prefix` in `dir`, deleting the rest.
 *
 * Orders by modification time, not filename: names embed a mode as well as a
 * timestamp, so a name sort would group by mode rather than by age.
 *
 * Never throws: failing to prune must not fail the operation that just wrote.
 */
export async function pruneOldest(
  dir: string,
  prefix: string,
  keep: number
): Promise<string[]> {
  if (!Number.isFinite(keep) || keep < 1) return [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Nothing written yet.
    return [];
  }

  const matching = entries.filter(name => name.startsWith(prefix));
  if (matching.length <= keep) return [];

  const dated: { name: string; modifiedMs: number }[] = [];
  for (const name of matching) {
    try {
      const stats = await fs.stat(path.join(dir, name));
      dated.push({ name, modifiedMs: stats.mtimeMs });
    } catch {
      // Vanished between readdir and stat.
    }
  }

  dated.sort((a, b) => a.modifiedMs - b.modifiedMs);

  const stale = dated.slice(0, Math.max(0, dated.length - keep));
  const deleted: string[] = [];

  for (const { name } of stale) {
    try {
      await fs.unlink(path.join(dir, name));
      deleted.push(name);
    } catch {
      // Best-effort: another run may have removed it already.
    }
  }

  return deleted;
}
