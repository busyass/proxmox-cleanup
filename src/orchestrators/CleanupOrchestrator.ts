import {
  CleanupConfig,
  CleanupResult,
  Resource,
  Report,
  CleanupError
} from '../types';
import {
  IDockerClient,
  IResourceScanner,
  IBackupManager,
  IReporter,
  ICleanupOrchestrator,
  UnusedResources
} from '../interfaces';
import { SizeCalculator } from '../utils/SizeCalculator';
import { AgeFilter } from '../utils/AgeFilter';
import { errorMessage, isRecoverableDockerErrorType } from '../utils/errors';

/** Shown when the Engine reports no creation time. */
const UNKNOWN_AGE_REASON =
  'creation time unavailable from the Docker Engine — cannot apply --older-than';

export class CleanupOrchestrator implements ICleanupOrchestrator {
  private dockerClient: IDockerClient;
  private resourceScanner: IResourceScanner;
  private backupManager: IBackupManager;
  private reporter: IReporter;
  private config: CleanupConfig;

  constructor(
    dockerClient: IDockerClient,
    resourceScanner: IResourceScanner,
    backupManager: IBackupManager,
    reporter: IReporter,
    config: CleanupConfig
  ) {
    this.dockerClient = dockerClient;
    this.resourceScanner = resourceScanner;
    this.backupManager = backupManager;
    this.reporter = reporter;
    this.config = config;
  }

  /**
   * Parse the configured minimum age to ms, or undefined if unset. Throws on bad input.
   */
  private minAgeMs(): number | undefined {
    const { minAge } = this.config.cleanup;
    return minAge ? AgeFilter.parseDuration(minAge) : undefined;
  }

  async executeCleanup(): Promise<Report> {
    const startTime = Date.now();
    const mode = this.config.cleanup.dryRun ? 'dry-run' : 'cleanup';

    try {
      const thresholdMs = this.minAgeMs(); // throws on invalid duration, before any Docker call
      await this.connectToDocker();

      const allResources = await this.scanAll();

      this.reporter.logOperationStart(mode, allResources.length);

      const { resources: sortedResources, skippedUnknownAge: unknownAge } =
        this.selectCandidates(allResources, thresholdMs);

      if (this.config.cleanup.backupEnabled && !this.config.cleanup.dryRun) {
        await this.createBackup(sortedResources);
      }

      const cleanupResult = await this.performCleanup(sortedResources);

      if (unknownAge.length > 0) {
        cleanupResult.skippedUnknownAge = unknownAge;
        unknownAge.forEach(r => this.reporter.logResourceSkip(r, UNKNOWN_AGE_REASON));
      }

      // A lower bound: the Engine reports no size for volumes or networks.
      const diskSpaceFreed = SizeCalculator.calculateTotalSize(cleanupResult.removed);
      const executionTime = Date.now() - startTime;

      const finalResult: CleanupResult = {
        ...cleanupResult,
        diskSpaceFreed,
        executionTime
      };

      const report = this.reporter.generateReport(mode, allResources, finalResult, executionTime);

      await this.reporter.saveReport(report);
      await this.reporter.saveSummary(report);

      this.reporter.logOperationComplete(report);

      return report;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorResult: CleanupResult = {
        removed: [],
        skipped: [],
        errors: [{
          type: 'unknown',
          message: errorMessage(error),
          timestamp: new Date(),
          recoverable: false
        }],
        diskSpaceFreed: 0,
        executionTime
      };

      const report = this.reporter.generateReport(mode, [], errorResult, executionTime);
      this.reporter.logOperationComplete(report);

      throw error;
    }
  }

  async executeDryRun(): Promise<Report> {
    const originalDryRun = this.config.cleanup.dryRun;
    this.config.cleanup.dryRun = true;
    this.resourceScanner.setDryRun(true);

    try {
      return await this.executeCleanup();
    } finally {
      this.config.cleanup.dryRun = originalDryRun;
      this.resourceScanner.setDryRun(originalDryRun);
    }
  }

  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (newConfig.cleanup?.dryRun !== undefined) {
      this.resourceScanner.setDryRun(newConfig.cleanup.dryRun);
    }
  }

  private async connectToDocker(): Promise<void> {
    if (!this.dockerClient.isConnected()) {
      await this.dockerClient.connect();
    }
  }

  private async scanAll(): Promise<Resource[]> {
    const [containers, images, volumes, networks] = await Promise.all([
      this.resourceScanner.scanContainers(),
      this.resourceScanner.scanImages(),
      this.resourceScanner.scanVolumes(),
      this.resourceScanner.scanNetworks()
    ]);

    return [...containers, ...images, ...volumes, ...networks];
  }

  /**
   * Type filter, then age filter, then largest-first. The one place both
   * `executeCleanup` and `listUnused` decide what counts as a candidate.
   */
  private selectCandidates(
    allResources: Resource[],
    thresholdMs: number | undefined
  ): UnusedResources {
    const typeFiltered = this.filterResources(allResources);

    if (thresholdMs === undefined) {
      return {
        resources: SizeCalculator.sortResourcesBySize(typeFiltered),
        skippedUnknownAge: []
      };
    }

    const { kept, skippedUnknownAge } = AgeFilter.filterOlderThan(
      typeFiltered,
      thresholdMs,
      Date.now()
    );

    return {
      resources: SizeCalculator.sortResourcesBySize(kept),
      skippedUnknownAge
    };
  }

  /** Returns the unknown-age set alongside the candidates so callers can surface that count too. */
  async listUnused(): Promise<UnusedResources> {
    const thresholdMs = this.minAgeMs();
    await this.connectToDocker();
    const allResources = await this.scanAll();
    return this.selectCandidates(allResources, thresholdMs);
  }

  private filterResources(resources: Resource[]): Resource[] {
    const { resourceTypes } = this.config.cleanup;
    if (resourceTypes.length > 0) {
      return resources.filter(resource => resourceTypes.includes(resource.type));
    }
    return resources;
  }

  private async createBackup(resources: Resource[]): Promise<void> {
    try {
      const backupResult = await this.backupManager.createBackup(resources);
      this.reporter.logBackupOperation(
        resources.length,
        backupResult.backupPath,
        backupResult.success,
        backupResult.error
      );

      if (!backupResult.success) {
        throw new Error(`Backup failed: ${backupResult.error}`);
      }
    } catch (error) {
      this.reporter.logBackupOperation(
        resources.length,
        '',
        false,
        errorMessage(error)
      );
      throw error;
    }
  }

  private async performCleanup(resources: Resource[]): Promise<CleanupResult> {
    const result = await this.resourceScanner.performCleanup(resources);

    const isDryRun = this.config.cleanup.dryRun;
    result.removed.forEach(r => this.reporter.logResourceRemoval(r, true, undefined, isDryRun));
    result.skipped.forEach(r =>
      this.reporter.logResourceSkip(r, result.skipReasons.get(r.id) ?? 'still in use')
    );

    // Keep the classification the client worked out.
    const errors: CleanupError[] = result.errors.map(e => ({
      type: e.type,
      message: e.error,
      timestamp: new Date(),
      recoverable: isRecoverableDockerErrorType(e.type),
      resource: e.resource
    }));
    errors.forEach(e => {
      if (e.resource) {
        this.reporter.logResourceRemoval(e.resource, false, e.message);
      }
    });

    return {
      removed: result.removed,
      skipped: result.skipped,
      errors,
      diskSpaceFreed: 0, // set by caller
      executionTime: 0   // set by caller
    };
  }
}
