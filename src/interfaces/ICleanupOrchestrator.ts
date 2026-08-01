import { CleanupConfig, Report, Resource } from '../types';

/**
 * Scan candidates, plus the resources the age filter could not judge. Both
 * travel together so callers can surface the skipped count.
 */
export interface UnusedResources {
  resources: Resource[];
  skippedUnknownAge: Resource[];
}

/**
 * Interface for cleanup orchestration
 */
export interface ICleanupOrchestrator {
  /**
   * Execute the complete cleanup workflow
   */
  executeCleanup(): Promise<Report>;

  /**
   * Execute dry-run workflow
   */
  executeDryRun(): Promise<Report>;

  /** List unused resources without removing anything. */
  listUnused(): Promise<UnusedResources>;

  /**
   * Get cleanup configuration
   */
  getConfig(): CleanupConfig;

  /**
   * Update cleanup configuration
   */
  updateConfig(newConfig: Partial<CleanupConfig>): void;
}
