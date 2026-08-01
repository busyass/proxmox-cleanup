import { Resource } from '../types';

/**
 * Utility for calculating resource sizes and formatting byte counts.
 *
 * Resource sizes come directly from the Docker API: containers get SizeRw
 * when listContainers({ size: true }) is called, images carry their Size
 * field, and volumes/networks have no accurate size available over the
 * Engine API so they stay at 0.
 */
export class SizeCalculator {
  /**
   * Sum resource sizes. Each resource already carries the best-known size
   * from the Docker API; this helper just aggregates.
   */
  static calculateTotalSize(resources: Resource[]): number {
    return resources.reduce((total, resource) => total + (resource.size || 0), 0);
  }

  /**
   * Sort resources by size in descending order
   */
  static sortResourcesBySize(resources: Resource[]): Resource[] {
    return [...resources].sort((a, b) => b.size - a.size);
  }

  /**
   * Size for display. Volumes and networks arrive as 0 because the Engine
   * reports none, and "0 B" would read as "empty" rather than "unknown".
   */
  static describeSize(resource: Resource): string {
    if (SizeCalculator.hasKnownSize(resource)) {
      return SizeCalculator.formatBytes(resource.size);
    }
    return resource.type === 'network' ? 'no size' : 'size unknown';
  }

  /** Whether the Engine reports a real size for this type. */
  static hasKnownSize(resource: Resource): boolean {
    return resource.type === 'container' || resource.type === 'image';
  }

  /**
   * Format bytes as a human-readable string (e.g. "1.2 GB").
   */
  static formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];

    if (bytes < k) {
      return parseFloat(bytes.toFixed(2)) + ' B';
    }

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const sizeIndex = Math.min(i, sizes.length - 1);
    const size = sizes[sizeIndex];

    return parseFloat((bytes / Math.pow(k, sizeIndex)).toFixed(2)) + ' ' + size;
  }
}
