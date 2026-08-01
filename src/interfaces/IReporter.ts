import { Resource, CleanupResult, Report } from '../types';
import winston from 'winston';

/**
 * Interface for reporting and logging operations
 */
export interface IReporter {
  /**
   * Generate a comprehensive cleanup report
   */
  generateReport(
    mode: 'dry-run' | 'cleanup',
    scannedResources: Resource[],
    result: CleanupResult,
    executionTime: number
  ): Report;

  /**
   * Generate summary statistics
   */
  generateSummary(report: Report): string;

  /**
   * Save report to file
   */
  saveReport(report: Report, filename?: string): Promise<string>;

  /**
   * Save summary to file
   */
  saveSummary(report: Report, filename?: string): Promise<string>;

  /**
   * Log cleanup operation start
   */
  logOperationStart(mode: 'dry-run' | 'cleanup', resourceCount: number): void;

  /**
   * Log cleanup operation completion
   */
  logOperationComplete(report: Report): void;

  /**
   * Log resource removal
   */
  logResourceRemoval(resource: Resource, success: boolean, error?: string, dryRun?: boolean): void;

  /**
   * Log resource skip
   */
  logResourceSkip(resource: Resource, reason: string): void;

  /**
   * Log backup operation
   */
  logBackupOperation(resourceCount: number, backupPath: string, success: boolean, error?: string): void;

  /**
   * Get logger instance for external use
   */
  getLogger(): winston.Logger;
}
