import { CleanupOrchestrator } from '../CleanupOrchestrator';
import {
  IDockerClient,
  IResourceScanner,
  IBackupManager,
  IReporter
} from '../../interfaces';
import {
  CleanupConfig,
  Resource,
  ContainerResource,
  ImageResource,
  BackupResult,
  CleanupErrorDetail,
  Report
} from '../../types';

// Mock implementations
class MockDockerClient implements IDockerClient {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listContainers(): Promise<ContainerResource[]> { return []; }
  async listImages(): Promise<ImageResource[]> { return []; }
  async listVolumes(): Promise<any[]> { return []; }
  async listNetworks(): Promise<any[]> { return []; }
  async removeContainer(): Promise<void> {}
  async removeImage(): Promise<void> {}
  async removeVolume(): Promise<void> {}
  async removeNetwork(): Promise<void> {}
}

class MockResourceScanner implements IResourceScanner {
  private dryRun = false;
  private mockResources: Resource[] = [];

  constructor(mockResources: Resource[] = []) {
    this.mockResources = mockResources;
  }

  async scanContainers(): Promise<ContainerResource[]> {
    return this.mockResources.filter(r => r.type === 'container') as ContainerResource[];
  }

  async scanImages(): Promise<ImageResource[]> {
    return this.mockResources.filter(r => r.type === 'image') as ImageResource[];
  }

  async scanVolumes(): Promise<any[]> {
    return this.mockResources.filter(r => r.type === 'volume');
  }

  async scanNetworks(): Promise<any[]> {
    return this.mockResources.filter(r => r.type === 'network');
  }

  async isResourceInUse(): Promise<boolean> {
    return false; // Mock as not in use
  }

  async performCleanup(resources: Resource[]): Promise<{
    removed: Resource[],
    skipped: Resource[],
    skipReasons: Map<string, string>,
    errors: CleanupErrorDetail[]
  }> {
    return { removed: resources, skipped: [], skipReasons: new Map(), errors: [] };
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }
}

class MockBackupManager implements IBackupManager {
  private shouldFail = false;

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  async createBackup(): Promise<BackupResult> {
    if (this.shouldFail) {
      return {
        success: false,
        backupPath: '',
        error: 'Backup failed'
      };
    }
    return {
      success: true,
      backupPath: '/tmp/backup.json',
      error: undefined
    };
  }

  async saveBackup(): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Save backup failed');
    }
  }

  async loadBackup(): Promise<any> {
    return {
      timestamp: new Date(),
      resources: [],
      metadata: {
        proxmoxHost: 'test-host',
        totalSize: 0,
        resourceCount: 0
      }
    };
  }
}

class MockReporter implements IReporter {
  private reports: Report[] = [];

  generateReport(mode: 'dry-run' | 'cleanup', scannedResources: Resource[], result: any, executionTime: number): Report {
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
    this.reports.push(report);
    return report;
  }

  generateSummary(): string { return 'Mock summary'; }
  async saveReport(): Promise<string> { return '/tmp/report.json'; }
  async saveSummary(): Promise<string> { return '/tmp/summary.txt'; }
  logOperationStart(): void {}
  logOperationComplete(): void {}
  removalLogs: { name: string; dryRun: boolean }[] = [];
  logResourceRemoval(resource: Resource, _success: boolean, _error?: string, dryRun = false): void {
    this.removalLogs.push({ name: resource.name, dryRun });
  }
  logResourceSkip(): void {}
  logBackupOperation(): void {}
  getLogger(): any {
    return {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn()
    };
  }

  getReports(): Report[] {
    return this.reports;
  }
}

describe('CleanupOrchestrator Integration Tests', () => {
  let orchestrator: CleanupOrchestrator;
  let mockDockerClient: MockDockerClient;
  let mockResourceScanner: MockResourceScanner;
  let mockBackupManager: MockBackupManager;
  let mockReporter: MockReporter;
  let mockConfig: CleanupConfig;

  beforeEach(() => {
    mockDockerClient = new MockDockerClient();
    mockResourceScanner = new MockResourceScanner();
    mockBackupManager = new MockBackupManager();
    mockReporter = new MockReporter();

    mockConfig = {
      proxmox: {
        host: 'proxmox.example.com',
        token: 'root@pam:password'
      },
      cleanup: {
        dryRun: false,
        resourceTypes: [],
        protectedPatterns: [],
        backupEnabled: true,
        backupPath: '/tmp/backups'
      },
      reporting: {
        verbose: true,
        logPath: '/tmp/logs'
      }
    };

    orchestrator = new CleanupOrchestrator(
      mockDockerClient,
      mockResourceScanner,
      mockBackupManager,
      mockReporter,
      mockConfig
    );
  });

  describe('End-to-End Cleanup Workflow', () => {
    it('should execute complete cleanup workflow successfully', async () => {
      // Setup mock resources
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        },
        {
          id: 'image1',
          name: 'unused-image',
          type: 'image',
          size: 5000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);
      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      const report = await orchestrator.executeCleanup();

      // Verify workflow execution
      expect(mockDockerClient.isConnected()).toBe(true);
      expect(report.mode).toBe('cleanup');
      expect(report.summary.resourcesScanned).toBe(2);
      expect(report.summary.resourcesRemoved).toBe(2);
      expect(report.summary.diskSpaceFreed).toBeGreaterThan(0);
      expect(report.details.removed).toHaveLength(2);
      expect(report.details.skipped).toHaveLength(0);
      expect(report.details.errors).toHaveLength(0);
    });

    it('should execute dry-run workflow successfully', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);
      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      const report = await orchestrator.executeDryRun();

      // Verify dry-run execution
      expect(report.mode).toBe('dry-run');
      expect(report.summary.resourcesScanned).toBe(1);
      expect(report.summary.resourcesRemoved).toBe(1);
      expect(report.details.removed).toHaveLength(1);
      expect(report.details.errors).toHaveLength(0);
    });

    it('should handle backup creation during cleanup', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);
      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      const report = await orchestrator.executeCleanup();

      expect(report.summary.resourcesRemoved).toBe(1);
      expect(report.details.errors).toHaveLength(0);
    });

    it('should handle backup failure and abort cleanup', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);
      mockBackupManager.setShouldFail(true);

      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      await expect(orchestrator.executeCleanup()).rejects.toThrow('Backup failed');
    });

    it('should skip backup in dry-run mode', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);
      mockBackupManager.setShouldFail(true); // This should not affect dry-run

      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      const report = await orchestrator.executeDryRun();

      expect(report.mode).toBe('dry-run');
      expect(report.summary.resourcesRemoved).toBe(1);
      expect(report.details.errors).toHaveLength(0);
    });

    it('should filter resources by type when specified', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        },
        {
          id: 'image1',
          name: 'unused-image',
          type: 'image',
          size: 5000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      mockResourceScanner = new MockResourceScanner(mockResources);

      // Configure to only clean containers
      const configWithFilter = {
        ...mockConfig,
        cleanup: {
          ...mockConfig.cleanup,
          resourceTypes: ['container' as const]
        }
      };

      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        configWithFilter
      );

      const report = await orchestrator.executeCleanup();

      expect(report.summary.resourcesScanned).toBe(2); // Both scanned
      expect(report.summary.resourcesRemoved).toBe(1); // Only container removed
      expect(report.details.removed[0].type).toBe('container');
    });

    it('should handle errors gracefully and continue cleanup', async () => {
      const mockResources: Resource[] = [
        {
          id: 'container1',
          name: 'unused-container',
          type: 'container',
          size: 1000000,
          createdAt: new Date(),
          tags: []
        }
      ];

      // Create a scanner that throws errors
      class ErrorResourceScanner extends MockResourceScanner {
        async performCleanup(resources: Resource[]) {
          return {
            removed: [] as Resource[],
            skipped: [] as Resource[],
            skipReasons: new Map<string, string>(),
            errors: resources.map(r => ({
              resource: r,
              type: 'resource_in_use' as const,
              error: 'Mock error'
            }))
          };
        }
      }

      mockResourceScanner = new ErrorResourceScanner(mockResources);
      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      const report = await orchestrator.executeCleanup();

      expect(report.summary.resourcesScanned).toBe(1);
      expect(report.summary.resourcesRemoved).toBe(0);
      expect(report.details.errors).toHaveLength(1);
      expect(report.details.errors[0].message).toBe('Mock error');
    });
  });

  describe('Configuration Management', () => {
    it('should return current configuration', () => {
      const config = orchestrator.getConfig();
      expect(config).toEqual(mockConfig);
    });

    it('should update configuration', () => {
      const newConfig = {
        cleanup: {
          dryRun: true,
          resourceTypes: ['container' as const],
          protectedPatterns: ['important-*'],
          backupEnabled: false,
          backupPath: '/new/path'
        }
      };

      orchestrator.updateConfig(newConfig);
      const updatedConfig = orchestrator.getConfig();

      expect(updatedConfig.cleanup.dryRun).toBe(true);
      expect(updatedConfig.cleanup.resourceTypes).toEqual(['container']);
      expect(updatedConfig.cleanup.protectedPatterns).toEqual(['important-*']);
      expect(updatedConfig.cleanup.backupEnabled).toBe(false);
    });

    it('should update scanner dry-run mode when config changes', () => {
      expect(mockResourceScanner.isDryRun()).toBe(false);

      orchestrator.updateConfig({
        cleanup: { ...mockConfig.cleanup, dryRun: true }
      });

      expect(mockResourceScanner.isDryRun()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle Docker connection failure', async () => {
      // Create a client that fails to connect
      class FailingDockerClient extends MockDockerClient {
        async connect(): Promise<void> {
          throw new Error('Connection failed');
        }
      }

      orchestrator = new CleanupOrchestrator(
        new FailingDockerClient(),
        mockResourceScanner,
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      await expect(orchestrator.executeCleanup()).rejects.toThrow('Connection failed');
    });

    it('should handle resource scanning failure', async () => {
      // Create a scanner that fails
      class FailingResourceScanner extends MockResourceScanner {
        async scanContainers(): Promise<ContainerResource[]> {
          throw new Error('Scan failed');
        }
      }

      orchestrator = new CleanupOrchestrator(
        mockDockerClient,
        new FailingResourceScanner(),
        mockBackupManager,
        mockReporter,
        mockConfig
      );

      await expect(orchestrator.executeCleanup()).rejects.toThrow('Scan failed');
    });
  });

  describe('--older-than age filtering', () => {
    const now = Date.now();
    const makeConfig = (minAge?: string): CleanupConfig => ({
      proxmox: { host: '', token: '' },
      cleanup: { dryRun: true, resourceTypes: [], protectedPatterns: [], backupEnabled: false, backupPath: './b', minAge },
      reporting: { verbose: false, logPath: './logs' }
    });

    it('removes only resources older than the threshold in dry-run', async () => {
      const resources: Resource[] = [
        { id: 'old', name: 'old', type: 'image', size: 1, createdAt: new Date(now - 10 * 86_400_000), tags: [] },
        { id: 'new', name: 'new', type: 'image', size: 1, createdAt: new Date(now - 1 * 86_400_000), tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig('7d')
      );
      const report = await orch.executeDryRun();
      expect(report.details.removed.map(r => r.id)).toEqual(['old']);
    });

    it('surfaces unknown-age resources as skipped, never removed', async () => {
      const resources: Resource[] = [
        { id: 'vol', name: 'vol', type: 'volume', size: 0, createdAt: undefined, tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig('7d')
      );
      const report = await orch.executeDryRun();
      expect(report.details.removed).toHaveLength(0);
      // Dedicated channel — NOT report.details.skipped (which feeds success-rate).
      expect(report.details.skippedUnknownAge?.map(r => r.id)).toContain('vol');
      expect(report.details.skipped).toHaveLength(0);
    });

    it('throws on an invalid duration before connecting to Docker', async () => {
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner([]),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig('nonsense')
      );
      await expect(orch.executeDryRun()).rejects.toThrow(/Invalid duration/);
    });

    it('does no age filtering when minAge is unset', async () => {
      const resources: Resource[] = [
        { id: 'new', name: 'new', type: 'image', size: 1, createdAt: new Date(now), tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig(undefined)
      );
      const report = await orch.executeDryRun();
      expect(report.details.removed.map(r => r.id)).toEqual(['new']);
    });

    it('marks the removal log as would-remove during a dry-run', async () => {
      // The log said "Removed network: x" on a dry-run that deleted nothing.
      const resources: Resource[] = [
        { id: 'n1', name: 'orphan-net', type: 'network', size: 0, tags: [] }
      ];
      const reporter = new MockReporter();
      const config = makeConfig();
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        reporter,
        config
      );

      await orch.executeDryRun();
      expect(reporter.removalLogs).toEqual([{ name: 'orphan-net', dryRun: true }]);

      // makeConfig defaults to dry-run, so a real run has to say so.
      reporter.removalLogs = [];
      config.cleanup.dryRun = false;
      await orch.executeCleanup();
      expect(reporter.removalLogs).toEqual([{ name: 'orphan-net', dryRun: false }]);
    });

    it('listUnused respects age filter, returning only age-eligible resources', async () => {
      const resources: Resource[] = [
        { id: 'old', name: 'old', type: 'image', size: 100, createdAt: new Date(now - 10 * 86_400_000), tags: [] },
        { id: 'new', name: 'new', type: 'image', size: 200, createdAt: new Date(now - 1 * 86_400_000), tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig('7d')
      );
      const result = await orch.listUnused();
      // listUnused shares the same filter + sort pipeline as cleanup, so only 'old' should be returned.
      expect(result.resources.map(r => r.id)).toEqual(['old']);
      expect(result.skippedUnknownAge).toEqual([]);
    });

    it('listUnused surfaces unknown-age resources instead of dropping them', async () => {
      // The `list` channel used to discard this set, so a filtered listing
      // looked like there was nothing left to reclaim.
      const resources: Resource[] = [
        { id: 'old', name: 'old', type: 'image', size: 100, createdAt: new Date(now - 10 * 86_400_000), tags: [] },
        { id: 'undated-vol', name: 'undated-vol', type: 'volume', size: 0, tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig('7d')
      );

      const result = await orch.listUnused();
      expect(result.resources.map(r => r.id)).toEqual(['old']);
      expect(result.skippedUnknownAge.map(r => r.id)).toEqual(['undated-vol']);
    });

    it('listUnused reports no unknown-age set when no age filter is active', async () => {
      const resources: Resource[] = [
        { id: 'undated-vol', name: 'undated-vol', type: 'volume', size: 0, tags: [] }
      ];
      const orch = new CleanupOrchestrator(
        new MockDockerClient(),
        new MockResourceScanner(resources),
        new MockBackupManager(),
        new MockReporter(),
        makeConfig()
      );

      const result = await orch.listUnused();
      // Without --older-than an undated resource is an ordinary candidate.
      expect(result.resources.map(r => r.id)).toEqual(['undated-vol']);
      expect(result.skippedUnknownAge).toEqual([]);
    });
  });
});
