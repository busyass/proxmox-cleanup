import { Resource, CleanupResult, Report } from '../types';
import { SizeCalculator } from '../utils/SizeCalculator';
import { errorMessage } from '../utils/errors';
import { isoSlug } from '../utils/time';
import { pruneOldest } from '../utils/retention';
import * as fs from 'fs';
import * as path from 'path';
import winston from 'winston';

/** Default retained report/summary pairs. */
const DEFAULT_KEEP_REPORTS = 30;

const REPORT_PREFIX = 'cleanup-report-';
const SUMMARY_PREFIX = 'cleanup-summary-';

/**
 * Reporter for generating cleanup summaries and logs
 */
export class Reporter {
  private logger!: winston.Logger;
  private logPath: string;
  private silentConsole: boolean;
  private keepReports: number;

  constructor(
    logPath: string = './logs',
    silentConsole: boolean = false,
    keepReports: number = DEFAULT_KEEP_REPORTS
  ) {
    this.logPath = logPath;
    this.silentConsole = silentConsole;
    this.keepReports = keepReports;
    this.setupLogger();
  }

  /**
   * Generate a comprehensive cleanup report
   */
  generateReport(
    mode: 'dry-run' | 'cleanup',
    scannedResources: Resource[],
    result: CleanupResult,
    executionTime: number
  ): Report {
    const report: Report = {
      timestamp: new Date(),
      mode,
      summary: {
        resourcesScanned: scannedResources.length,
        resourcesRemoved: result.removed.length,
        diskSpaceFreed: result.diskSpaceFreed,
        executionTime
      },
      details: {
        removed: result.removed,
        skipped: result.skipped,
        errors: result.errors,
        skippedUnknownAge: result.skippedUnknownAge
      }
    };

    // Log the report
    this.logReport(report);

    return report;
  }

  /**
   * Generate summary statistics
   */
  generateSummary(report: Report): string {
    const { summary, details } = report;
    const lines: string[] = [];

    lines.push(`=== Proxmox Cleanup Report (${report.mode.toUpperCase()}) ===`);
    lines.push(`Timestamp: ${report.timestamp.toISOString()}`);
    lines.push('');

    // Summary section
    lines.push('SUMMARY:');
    lines.push(`  Resources Scanned: ${summary.resourcesScanned}`);
    lines.push(`  Resources ${report.mode === 'dry-run' ? 'Would Be ' : ''}Removed: ${summary.resourcesRemoved}`);
    lines.push(`  Disk Space ${report.mode === 'dry-run' ? 'Would Be ' : ''}Freed: ${SizeCalculator.formatBytes(summary.diskSpaceFreed)}`);
    lines.push(`  Execution Time: ${(summary.executionTime / 1000).toFixed(2)}s`);
    lines.push('');

    // Resource breakdown
    const resourceCounts = this.getResourceCounts(details.removed);
    if (Object.keys(resourceCounts).length > 0) {
      lines.push('RESOURCE BREAKDOWN:');
      Object.entries(resourceCounts).forEach(([type, count]) => {
        lines.push(`  ${type.charAt(0).toUpperCase() + type.slice(1)}s: ${count}`);
      });
      lines.push('');
    }

    // Skipped resources
    if (details.skipped.length > 0) {
      lines.push('SKIPPED RESOURCES (left alone on purpose):');
      details.skipped.forEach(resource => {
        lines.push(`  ${resource.type}: ${resource.name} (${SizeCalculator.describeSize(resource)})`);
      });
      lines.push('');
    }

    // Errors
    if (details.errors.length > 0) {
      lines.push('ERRORS:');
      details.errors.forEach(error => {
        lines.push(`  ${error.type}: ${error.message}`);
        if (error.resource) {
          lines.push(`    Resource: ${error.resource.type}/${error.resource.name}`);
        }
      });
      lines.push('');
    }

    // Skipped unknown age
    if (details.skippedUnknownAge && details.skippedUnknownAge.length > 0) {
      lines.push('SKIPPED (creation time unavailable from the Docker Engine, --older-than could not apply):');
      details.skippedUnknownAge.forEach(resource => {
        lines.push(`  ${resource.type}: ${resource.name}`);
      });
      lines.push('');
    }

    // Not a success rate: skipped resources are correct behaviour, not failures.
    if (details.errors.length > 0) {
      lines.push(`Failed to remove: ${details.errors.length} of ${summary.resourcesRemoved + details.errors.length} attempted`);
    } else {
      lines.push('No failures.');
    }

    return lines.join('\n');
  }

  /**
   * Save report to file
   */
  async saveReport(report: Report, filename?: string): Promise<string> {
    // Ensure log directory exists
    await this.ensureLogDirectory();

    // Generate filename if not provided
    if (!filename) {
      filename = `${REPORT_PREFIX}${report.mode}-${isoSlug(report.timestamp)}.json`;
    }

    const filePath = path.join(this.logPath, filename);
    const reportJson = JSON.stringify(report, null, 2);

    try {
      await fs.promises.writeFile(filePath, reportJson, 'utf8');
      this.logger.info(`Report saved to ${filePath}`);
      await this.pruneOldReports(`${REPORT_PREFIX}${report.mode}-`);
      return filePath;
    } catch (error) {
      const message = `Failed to save report: ${errorMessage(error)}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  /**
   * Save summary to file
   */
  async saveSummary(report: Report, filename?: string): Promise<string> {
    // Ensure log directory exists
    await this.ensureLogDirectory();

    // Generate filename if not provided
    if (!filename) {
      filename = `${SUMMARY_PREFIX}${report.mode}-${isoSlug(report.timestamp)}.txt`;
    }

    const filePath = path.join(this.logPath, filename);
    const summary = this.generateSummary(report);

    try {
      await fs.promises.writeFile(filePath, summary, 'utf8');
      this.logger.info(`Summary saved to ${filePath}`);
      await this.pruneOldReports(`${SUMMARY_PREFIX}${report.mode}-`);
      return filePath;
    } catch (error) {
      const message = `Failed to save summary: ${errorMessage(error)}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  /**
   * Log cleanup operation start
   */
  logOperationStart(mode: 'dry-run' | 'cleanup', resourceCount: number): void {
    this.logger.info(`Starting ${mode} operation`, {
      mode,
      resourceCount,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log cleanup operation completion
   */
  logOperationComplete(report: Report): void {
    this.logger.info(`${report.mode} operation completed`, {
      mode: report.mode,
      resourcesScanned: report.summary.resourcesScanned,
      resourcesRemoved: report.summary.resourcesRemoved,
      diskSpaceFreed: report.summary.diskSpaceFreed,
      executionTime: report.summary.executionTime,
      errorCount: report.details.errors.length,
      timestamp: report.timestamp.toISOString()
    });
  }

  /**
   * Log resource removal. `dryRun` keeps the log honest: nothing was removed,
   * so it must not say it was.
   */
  logResourceRemoval(resource: Resource, success: boolean, error?: string, dryRun = false): void {
    if (success) {
      const action = dryRun ? 'Would remove' : 'Removed';
      this.logger.info(`${action} ${resource.type}: ${resource.name}`, {
        resourceType: resource.type,
        resourceName: resource.name,
        resourceId: resource.id,
        size: resource.size,
        timestamp: new Date().toISOString()
      });
    } else {
      this.logger.error(`Failed to remove ${resource.type}: ${resource.name}`, {
        resourceType: resource.type,
        resourceName: resource.name,
        resourceId: resource.id,
        error: error || 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Log resource skip
   */
  logResourceSkip(resource: Resource, reason: string): void {
    this.logger.warn(`Skipped ${resource.type}: ${resource.name}`, {
      resourceType: resource.type,
      resourceName: resource.name,
      resourceId: resource.id,
      reason,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log backup operation
   */
  logBackupOperation(resourceCount: number, backupPath: string, success: boolean, error?: string): void {
    if (success) {
      this.logger.info('Backup created successfully', {
        resourceCount,
        backupPath,
        timestamp: new Date().toISOString()
      });
    } else {
      this.logger.error('Backup creation failed', {
        resourceCount,
        backupPath,
        error: error || 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get logger instance for external use
   */
  getLogger(): winston.Logger {
    return this.logger;
  }

  /**
   * Setup Winston logger with file and console transports
   */
  private setupLogger(): void {
    // Ensure log directory exists
    this.ensureLogDirectorySync();

    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    );

    this.logger = winston.createLogger({
      level: 'info',
      format: logFormat,
      transports: [
        // File transport for all logs
        new winston.transports.File({
          filename: path.join(this.logPath, 'cleanup.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true
        }),
        // File transport for errors only
        new winston.transports.File({
          filename: path.join(this.logPath, 'cleanup-error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true
        }),
        // Console transport
        new winston.transports.Console({
          format: consoleFormat,
          level: process.env.NODE_ENV === 'test' ? 'error' : 'info',
          silent: this.silentConsole
        })
      ]
    });
  }

  /**
   * Log the full report
   */
  private logReport(report: Report): void {
    this.logger.info('Cleanup report generated', {
      mode: report.mode,
      summary: report.summary,
      errorCount: report.details.errors.length,
      skippedCount: report.details.skipped.length,
      timestamp: report.timestamp.toISOString()
    });
  }

  /**
   * Get resource counts by type
   */
  private getResourceCounts(resources: Resource[]): Record<string, number> {
    const counts: Record<string, number> = {};

    resources.forEach(resource => {
      counts[resource.type] = (counts[resource.type] || 0) + 1;
    });

    return counts;
  }

  /**
   * Bound the report/summary files; logrotate only covers `*.log`.
   * The prefix includes the mode, so previews cannot evict the record of a
   * real cleanup.
   */
  private async pruneOldReports(prefix: string): Promise<void> {
    const deleted = await pruneOldest(this.logPath, prefix, this.keepReports);
    if (deleted.length > 0) {
      this.logger.info(`Pruned ${deleted.length} old ${prefix}* file(s), keeping the newest ${this.keepReports}`);
    }
  }

  /**
   * Ensure log directory exists (async)
   */
  private async ensureLogDirectory(): Promise<void> {
    await fs.promises.mkdir(this.logPath, { recursive: true });
  }

  /**
   * Ensure log directory exists (sync)
   */
  private ensureLogDirectorySync(): void {
    fs.mkdirSync(this.logPath, { recursive: true });
  }
}
