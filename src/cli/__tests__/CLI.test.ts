import { ProxmoxCleanupCLI } from '../index';
import { CleanupConfig } from '../../types';
import * as fs from 'fs';

// Mock all external dependencies
jest.mock('../../orchestrators/CleanupOrchestrator');
jest.mock('../../clients/DockerClient');
jest.mock('../../scanners/ResourceScanner');
jest.mock('../../managers/BackupManager');
jest.mock('../../reporters/Reporter');
jest.mock('../../clients/ProxmoxClient');
jest.mock('fs');
jest.mock('path');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('ProxmoxCleanupCLI', () => {
  let cli: ProxmoxCleanupCLI;
  let originalArgv: string[];
  let originalExit: typeof process.exit;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  // Capture console output
  let consoleOutput: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    // Save original values
    originalArgv = process.argv;
    originalExit = process.exit;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;

    // Mock console methods
    consoleOutput = [];
    consoleErrors = [];
    console.log = jest.fn((...args) => consoleOutput.push(args.join(' ')));
    console.error = jest.fn((...args) => consoleErrors.push(args.join(' ')));

    // Mock process.exit. Production sets process.exitCode instead, so that is
    // reset here too and asserted on directly.
    process.exit = jest.fn() as any;
    process.exitCode = undefined;

    // Reset mocks
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('{}');

    cli = new ProxmoxCleanupCLI();
  });

  afterEach(() => {
    // Restore original values
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = undefined;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('CLI Argument Parsing', () => {
    it('should parse cleanup command with all options', async () => {
      const testArgs = [
        'node',
        'cli.js',
        'cleanup',
        '--dry-run',
        '--types', 'containers,images',
        '--protect', 'important-*,system-*',
        '--backup',
        '--backup-path', '/custom/backup',
        '--verbose',
        '--log-path', '/custom/logs',
        '--proxmox-host', 'proxmox.example.com',
        '--proxmox-token', 'root@pam:password'
      ];

      process.argv = testArgs;

      // Mock successful execution
      const mockExecuteCleanup = jest.spyOn(cli as any, 'executeCleanup').mockResolvedValue(undefined);

      await cli.run();

      expect(mockExecuteCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
          types: 'containers,images',
          protect: 'important-*,system-*',
          backup: true,
          backupPath: '/custom/backup',
          verbose: true,
          logPath: '/custom/logs',
          proxmoxHost: 'proxmox.example.com',
          proxmoxToken: 'root@pam:password'
        })
      );
    });

    it('should parse dry-run command with options', async () => {
      const testArgs = [
        'node',
        'cli.js',
        'dry-run',
        '--types', 'volumes,networks',
        '--protect', 'keep-*',
        '--verbose'
      ];

      process.argv = testArgs;

      const mockExecuteDryRun = jest.spyOn(cli as any, 'executeDryRun').mockResolvedValue(undefined);

      await cli.run();

      expect(mockExecuteDryRun).toHaveBeenCalledWith(
        expect.objectContaining({
          types: 'volumes,networks',
          protect: 'keep-*',
          verbose: true
        })
      );
    });

    it('should parse list command with options', async () => {
      const testArgs = [
        'node',
        'cli.js',
        'list',
        '--types', 'images'
      ];

      process.argv = testArgs;

      const mockListResources = jest.spyOn(cli as any, 'listResources').mockResolvedValue(undefined);

      await cli.run();

      expect(mockListResources).toHaveBeenCalledWith(
        expect.objectContaining({
          types: 'images'
        })
      );
    });

    it('should parse validate-config command', async () => {
      const testArgs = [
        'node',
        'cli.js',
        'validate-config',
        '--config', '/path/to/config.json'
      ];

      process.argv = testArgs;

      const mockValidateConfig = jest.spyOn(cli as any, 'validateConfig').mockResolvedValue(undefined);

      await cli.run();

      expect(mockValidateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          config: '/path/to/config.json'
        })
      );
    });

    it('should handle --no-backup option', async () => {
      const testArgs = [
        'node',
        'cli.js',
        'cleanup',
        '--no-backup'
      ];

      process.argv = testArgs;

      const mockExecuteCleanup = jest.spyOn(cli as any, 'executeCleanup').mockResolvedValue(undefined);

      await cli.run();

      expect(mockExecuteCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          backup: false
        })
      );
    });
  });

  describe('Configuration Loading', () => {
    it('should load configuration from file when specified', async () => {
      const mockConfig: CleanupConfig = {
        proxmox: {
          host: 'test-host',
          token: 'test-token'
        },
        cleanup: {
          dryRun: false,
          resourceTypes: ['container'],
          protectedPatterns: ['important-*'],
          backupEnabled: true,
          backupPath: '/test/backup'
        },
        reporting: {
          verbose: true,
          logPath: '/test/logs'
        }
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      const options = { config: '/path/to/config.json' };
      const config = await (cli as any).loadConfig(options);

      expect(mockFs.existsSync).toHaveBeenCalledWith('/path/to/config.json');
      expect(mockFs.readFileSync).toHaveBeenCalledWith('/path/to/config.json', 'utf8');
      expect(config).toEqual(mockConfig);
    });

    it('should create default configuration when no file specified', async () => {
      const options = {};
      const config = await (cli as any).loadConfig(options);

      expect(config).toEqual({
        proxmox: {
          host: '',
          token: ''
        },
        cleanup: {
          dryRun: false,
          resourceTypes: [],
          protectedPatterns: [],
          backupEnabled: true,
          backupPath: './backups'
        },
        reporting: {
          verbose: false,
          logPath: './logs'
        }
      });
    });

    it('should override config with CLI options', async () => {
      const options = {
        dryRun: true,
        types: 'containers,images',
        protect: 'keep-*,important-*',
        backup: false,
        backupPath: '/custom/backup',
        verbose: true,
        logPath: '/custom/logs',
        proxmoxHost: 'custom-host',
        proxmoxToken: 'custom-token'
      };

      const config = await (cli as any).loadConfig(options);

      expect(config.cleanup.dryRun).toBe(true);
      expect(config.cleanup.resourceTypes).toEqual(['container', 'image']);
      expect(config.cleanup.protectedPatterns).toEqual(['keep-*', 'important-*']);
      expect(config.cleanup.backupEnabled).toBe(false);
      expect(config.cleanup.backupPath).toBe('/custom/backup');
      expect(config.reporting.verbose).toBe(true);
      expect(config.reporting.logPath).toBe('/custom/logs');
      expect(config.proxmox.host).toBe('custom-host');
      expect(config.proxmox.token).toBe('custom-token');
    });

    // The gap that let the path options stay broken for three releases: every
    // existing test passed the flags, so nothing asserted what happens when a
    // user relies on their config file alone. commander used to supply
    // './backups' / './logs' as defaults, which always won.
    describe('config values survive when the flag is absent', () => {
      const installedConfig = {
        proxmox: { host: 'pve.local', token: 'root@pam:secret' },
        cleanup: {
          dryRun: false,
          resourceTypes: [],
          protectedPatterns: ['production-*'],
          backupEnabled: true,
          backupPath: '/var/backups/proxmox-cleanup'
        },
        reporting: { verbose: true, logPath: '/var/log/proxmox-cleanup' }
      };

      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(installedConfig) as any);
      });

      it('keeps backupPath from the config file', async () => {
        const config = await (cli as any).loadConfig({ config: '/etc/proxmox-cleanup/config.json' });
        expect(config.cleanup.backupPath).toBe('/var/backups/proxmox-cleanup');
      });

      it('keeps logPath from the config file', async () => {
        const config = await (cli as any).loadConfig({ config: '/etc/proxmox-cleanup/config.json' });
        expect(config.reporting.logPath).toBe('/var/log/proxmox-cleanup');
      });

      it('keeps protectedPatterns and backupEnabled from the config file', async () => {
        const config = await (cli as any).loadConfig({ config: '/etc/proxmox-cleanup/config.json' });
        expect(config.cleanup.protectedPatterns).toEqual(['production-*']);
        expect(config.cleanup.backupEnabled).toBe(true);
      });

      it('still lets an explicit flag win over the config file', async () => {
        const config = await (cli as any).loadConfig({
          config: '/etc/proxmox-cleanup/config.json',
          backupPath: '/tmp/elsewhere',
          logPath: '/tmp/logs'
        });
        expect(config.cleanup.backupPath).toBe('/tmp/elsewhere');
        expect(config.reporting.logPath).toBe('/tmp/logs');
      });

      it('keeps resourceTypes from the config file', async () => {
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          ...installedConfig,
          cleanup: { ...installedConfig.cleanup, resourceTypes: ['image'] }
        }) as any);

        // commander omits the key entirely when -t isn't passed, which is what
        // lets the config value survive. A default of 'all' here would clear it.
        const config = await (cli as any).loadConfig({ config: '/etc/proxmox-cleanup/config.json' });
        expect(config.cleanup.resourceTypes).toEqual(['image']);
      });

      it('lets --types all widen a config that narrowed the set', async () => {
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          ...installedConfig,
          cleanup: { ...installedConfig.cleanup, resourceTypes: ['image'] }
        }) as any);

        const config = await (cli as any).loadConfig({
          config: '/etc/proxmox-cleanup/config.json',
          types: 'all'
        });
        // Empty list means "no type filter", i.e. every type.
        expect(config.cleanup.resourceTypes).toEqual([]);
      });
    });

    it('refuses to run when a protection pattern cannot match anything', async () => {
      // Proceeding would delete resources the user believes are protected.
      await expect((cli as any).createOrchestrator({
        proxmox: { host: '', token: '' },
        cleanup: {
          dryRun: true, resourceTypes: [], protectedPatterns: ['tags:env'],
          backupEnabled: false, backupPath: './b'
        },
        reporting: { verbose: false, logPath: './l' }
      }, {})).rejects.toThrow(/cannot match anything[\s\S]*did you mean "tag:"/);
    });

    it('runs normally when every protection pattern is usable', async () => {
      await expect((cli as any).createOrchestrator({
        proxmox: { host: '', token: '' },
        cleanup: {
          dryRun: true, resourceTypes: [], protectedPatterns: ['keep-*', 'tag:env=prod'],
          backupEnabled: false, backupPath: './b'
        },
        reporting: { verbose: false, logPath: './l' }
      }, {})).resolves.toBeDefined();
    });

    it('does not double-prefix the validate-config failure message', async () => {
      // The command handler already prints "Config validation failed:", so
      // wrapping the message again read as "Config validation failed:
      // Configuration validation failed: ...".
      mockFs.existsSync.mockReturnValue(false);

      await expect((cli as any).validateConfig({ config: '/etc/nope.json' }))
        .rejects.toThrow(/^Configuration file not found/);
    });

    it('refuses a --config path that does not exist rather than silently using defaults', async () => {
      // Falling back would run a destructive command with none of the user's
      // protection patterns.
      mockFs.existsSync.mockReturnValue(false);

      await expect((cli as any).loadConfig({ config: '/etc/typo/config.json' }))
        .rejects.toThrow(/Configuration file not found/);
    });

    it('still uses built-in defaults when no --config is given', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const config = await (cli as any).loadConfig({});
      expect(config.cleanup.backupPath).toBe('./backups');
      expect(config.reporting.logPath).toBe('./logs');
    });

    it('should map --older-than to config.cleanup.minAge', async () => {
      const options = {
        olderThan: '14d'
      };

      const config = await (cli as any).loadConfig(options);

      expect(config.cleanup.minAge).toBe('14d');
    });
  });

  describe('Resource Type Parsing', () => {
    it('should parse valid resource types', () => {
      const result = (cli as any).parseResourceTypes('containers,images,volumes,networks');
      expect(result).toEqual(['container', 'image', 'volume', 'network']);
    });

    it('should handle single resource type', () => {
      const result = (cli as any).parseResourceTypes('containers');
      expect(result).toEqual(['container']);
    });

    it('should handle whitespace in resource types', () => {
      const result = (cli as any).parseResourceTypes(' containers , images ');
      expect(result).toEqual(['container', 'image']);
    });

    it('should throw error for invalid resource types', () => {
      expect(() => {
        (cli as any).parseResourceTypes('containers,invalid,images');
      }).toThrow('Invalid resource type: invalid');
    });

    it('should handle mixed case resource types', () => {
      const result = (cli as any).parseResourceTypes('Containers,IMAGES');
      expect(result).toEqual(['container', 'image']);
    });
  });

  describe('Utility Functions', () => {
    it('should get correct resource icons', () => {
      expect((cli as any).getResourceIcon('container')).toBe('📦');
      expect((cli as any).getResourceIcon('image')).toBe('🖼️');
      expect((cli as any).getResourceIcon('volume')).toBe('💾');
      expect((cli as any).getResourceIcon('network')).toBe('🌐');
      expect((cli as any).getResourceIcon('unknown')).toBe('📄');
    });
  });

  describe('Configuration Validation', () => {
    it('should validate correct configuration structure', () => {
      const validConfig: CleanupConfig = {
        proxmox: { host: '', token: '' },
        cleanup: {
          dryRun: false,
          resourceTypes: ['container', 'image'],
          protectedPatterns: [],
          backupEnabled: true,
          backupPath: './backups'
        },
        reporting: { verbose: false, logPath: './logs' }
      };

      expect(() => {
        (cli as any).validateConfigStructure(validConfig);
      }).not.toThrow();
    });

    it('should throw error for missing sections', () => {
      const invalidConfig = {
        proxmox: { host: '', token: '' }
        // Missing cleanup and reporting sections
      };

      expect(() => {
        (cli as any).validateConfigStructure(invalidConfig);
      }).toThrow('Invalid configuration structure');
    });

    it('should throw error for invalid resource types', () => {
      const invalidConfig: any = {
        proxmox: { host: '', token: '' },
        cleanup: {
          dryRun: false,
          resourceTypes: ['container', 'invalid-type'],
          protectedPatterns: [],
          backupEnabled: true,
          backupPath: './backups'
        },
        reporting: { verbose: false, logPath: './logs' }
      };

      expect(() => {
        (cli as any).validateConfigStructure(invalidConfig);
      }).toThrow('Invalid resource types in config: invalid-type');
    });
  });

  describe('Error Handling', () => {
    it('should handle cleanup execution errors', async () => {
      const testArgs = ['node', 'cli.js', 'cleanup'];
      process.argv = testArgs;

      jest.spyOn(cli as any, 'executeCleanup').mockRejectedValue(new Error('Cleanup failed'));

      await cli.run();

      expect(process.exitCode).toBe(1);
      expect(consoleErrors).toContain('❌ Cleanup failed: Cleanup failed');
    });

    it('should handle dry-run execution errors', async () => {
      const testArgs = ['node', 'cli.js', 'dry-run'];
      process.argv = testArgs;

      jest.spyOn(cli as any, 'executeDryRun').mockRejectedValue(new Error('Dry-run failed'));

      await cli.run();

      expect(process.exitCode).toBe(1);
      expect(consoleErrors).toContain('❌ Dry-run failed: Dry-run failed');
    });

    it('should handle list resources errors', async () => {
      const testArgs = ['node', 'cli.js', 'list'];
      process.argv = testArgs;

      jest.spyOn(cli as any, 'listResources').mockRejectedValue(new Error('List failed'));

      await cli.run();

      expect(process.exitCode).toBe(1);
      expect(consoleErrors).toContain('❌ List failed: List failed');
    });

    it('should handle config validation errors', async () => {
      const testArgs = ['node', 'cli.js', 'validate-config'];
      process.argv = testArgs;

      jest.spyOn(cli as any, 'validateConfig').mockRejectedValue(new Error('Config invalid'));

      await cli.run();

      expect(process.exitCode).toBe(1);
      expect(consoleErrors).toContain('❌ Config validation failed: Config invalid');
    });

    it('should handle JSON parsing errors in config file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const options = { config: '/path/to/config.json' };

      await expect((cli as any).loadConfig(options)).rejects.toThrow();
    });
  });

  describe('--json output', () => {
    // Helper: the CLI's createOrchestrator is mocked (jest.mock at top of file).
    // Configure the mocked orchestrator's methods per test via the mock class.
    const { CleanupOrchestrator } = jest.requireMock('../../orchestrators/CleanupOrchestrator');

    it('list --json emits a single valid JSON document with summary and no emoji', async () => {
      const resources = [
        { id: 'i1', name: 'img', type: 'image', size: 100, tags: [] }
      ];
      CleanupOrchestrator.prototype.listUnused = jest.fn().mockResolvedValue({
        resources, skippedUnknownAge: []
      });

      process.argv = ['node', 'cli.js', 'list', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      // Exactly one stdout payload, and it parses.
      expect(consoleOutput).toHaveLength(1);
      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.summary.count).toBe(1);
      expect(parsed.summary.totalSize).toBe(100);
      expect(parsed.summary.byType.image).toEqual({ count: 1, size: 100 });
      expect(consoleOutput[0]).not.toMatch(/📋|🎉|💾/);
    });

    it('list --json surfaces the unknown-age set instead of dropping it', async () => {
      const resources = [{ id: 'i1', name: 'img', type: 'image', size: 100, tags: [] }];
      const undated = [{ id: 'v1', name: 'vol', type: 'volume', size: 0, tags: [] }];
      CleanupOrchestrator.prototype.listUnused = jest.fn().mockResolvedValue({
        resources, skippedUnknownAge: undated
      });

      process.argv = ['node', 'cli.js', 'list', '--json', '--older-than', '7d'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.skippedUnknownAge).toHaveLength(1);
      expect(parsed.summary.skippedUnknownAgeCount).toBe(1);
    });

    it('dry-run --json emits the Report verbatim', async () => {
      const report = {
        timestamp: new Date('2026-07-05T00:00:00Z'),
        mode: 'dry-run',
        summary: { resourcesScanned: 3, resourcesRemoved: 2, diskSpaceFreed: 500, executionTime: 10 },
        details: { removed: [], skipped: [], errors: [] }
      };
      CleanupOrchestrator.prototype.executeDryRun = jest.fn().mockResolvedValue(report);

      process.argv = ['node', 'cli.js', 'dry-run', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      expect(consoleOutput).toHaveLength(1);
      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.mode).toBe('dry-run');
      expect(parsed.summary.resourcesRemoved).toBe(2);
    });

    it('cleanup --json emits the Report verbatim', async () => {
      const report = {
        timestamp: new Date('2026-07-05T00:00:00Z'),
        mode: 'cleanup',
        summary: { resourcesScanned: 5, resourcesRemoved: 3, diskSpaceFreed: 1000, executionTime: 20 },
        details: { removed: [], skipped: [], errors: [] }
      };
      CleanupOrchestrator.prototype.executeCleanup = jest.fn().mockResolvedValue(report);

      process.argv = ['node', 'cli.js', 'cleanup', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      expect(consoleOutput).toHaveLength(1);
      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.mode).toBe('cleanup');
      expect(parsed.summary.resourcesRemoved).toBe(3);
    });

    it('validate-config --json emits {valid, checks} with proxmox: true when configured', async () => {
      const mockConfig = {
        proxmox: { host: 'test-host', token: 'test-token' },
        cleanup: {
          dryRun: false,
          resourceTypes: ['container'],
          protectedPatterns: [],
          backupEnabled: true,
          backupPath: './backups'
        },
        reporting: { verbose: false, logPath: './logs' }
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      // Mock the Proxmox and Docker clients
      const { ProxmoxClient } = jest.requireMock('../../clients/ProxmoxClient');
      const { DockerClient } = jest.requireMock('../../clients/DockerClient');
      ProxmoxClient.prototype.authenticate = jest.fn().mockResolvedValue(undefined);
      DockerClient.prototype.connect = jest.fn().mockResolvedValue(undefined);

      process.argv = ['node', 'cli.js', 'validate-config', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      expect(consoleOutput).toHaveLength(1);
      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.valid).toBe(true);
      expect(parsed.checks).toHaveProperty('structure');
      expect(parsed.checks.proxmox).toBe(true);
      expect(parsed.checks.docker).toBe(true);
    });

    it('validate-config --json emits checks.proxmox === null when no proxmox host is configured', async () => {
      const mockConfig = {
        proxmox: { host: '', token: '' },
        cleanup: {
          dryRun: false,
          resourceTypes: ['container'],
          protectedPatterns: [],
          backupEnabled: true,
          backupPath: './backups'
        },
        reporting: { verbose: false, logPath: './logs' }
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      // Mock the Docker client (Proxmox should be skipped)
      const { DockerClient } = jest.requireMock('../../clients/DockerClient');
      DockerClient.prototype.connect = jest.fn().mockResolvedValue(undefined);

      process.argv = ['node', 'cli.js', 'validate-config', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      expect(consoleOutput).toHaveLength(1);
      const parsed = JSON.parse(consoleOutput[0]);
      expect(parsed.valid).toBe(true);
      expect(parsed.checks.structure).toBe(true);
      expect(parsed.checks.proxmox).toBe(null);
      expect(parsed.checks.docker).toBe(true);
    });

    it('emits {error} JSON and exits non-zero on fatal failure', async () => {
      CleanupOrchestrator.prototype.executeDryRun = jest.fn().mockRejectedValue(new Error('Docker down'));

      process.argv = ['node', 'cli.js', 'dry-run', '--json'];
      cli = new ProxmoxCleanupCLI();
      await cli.run();

      const parsed = JSON.parse(consoleOutput[consoleOutput.length - 1]);
      expect(parsed.error.message).toContain('Docker down');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('Display Functions', () => {
    it('should display cleanup report correctly', () => {
      const mockReport = {
        summary: {
          resourcesScanned: 10,
          resourcesRemoved: 5,
          diskSpaceFreed: 1048576,
          executionTime: 1500
        },
        details: {
          removed: [
            { name: 'container1', type: 'container', size: 524288 },
            { name: 'image1', type: 'image', size: 524288 }
          ],
          skipped: [],
          errors: []
        }
      };

      (cli as any).displayReport({ ...mockReport, mode: 'cleanup' });

      expect(consoleOutput.some(line => line.includes('CLEANUP REPORT'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('Resources Scanned: 10'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('Resources Removed: 5'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('1 MB'))).toBe(true);
    });

    it('should display dry-run report correctly', () => {
      const mockReport = {
        summary: {
          resourcesScanned: 8,
          resourcesRemoved: 3,
          diskSpaceFreed: 2097152,
          executionTime: 800
        },
        details: {
          removed: [
            { name: 'container1', type: 'container', size: 1048576 }
          ],
          skipped: [
            { name: 'container2', type: 'container', size: 1048576 }
          ],
          errors: []
        }
      };

      (cli as any).displayReport({ ...mockReport, mode: 'dry-run' });

      expect(consoleOutput.some(line => line.includes('DRY-RUN REPORT'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('Would Be Removed: 3'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('Resources Skipped'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('This was a dry-run'))).toBe(true);
    });

    // The display mode is derived from report.mode, never passed in. A caller
    // used to hand displayReport a literal `false`, so `cleanup --dry-run`
    // announced a completed cleanup after deleting nothing.
    it('reads dry-run from the report, so it cannot contradict what ran', () => {
      const dryRunReport = {
        mode: 'dry-run' as const,
        summary: { resourcesScanned: 1, resourcesRemoved: 1, diskSpaceFreed: 0, executionTime: 1 },
        details: { removed: [], skipped: [], errors: [] }
      };

      (cli as any).displayReport(dryRunReport);

      const output = consoleOutput.join('\n');
      expect(output).toContain('DRY-RUN REPORT');
      expect(output).toContain('This was a dry-run');
      expect(output).not.toContain('Cleanup completed successfully');
      expect(output).not.toContain('🧹 CLEANUP REPORT');
    });

    it('does not leave a double space in the freed-space line', () => {
      (cli as any).displayReport({
        mode: 'cleanup' as const,
        summary: { resourcesScanned: 1, resourcesRemoved: 1, diskSpaceFreed: 1048576, executionTime: 1 },
        details: { removed: [], skipped: [], errors: [] }
      });

      expect(consoleOutput.some(line => line.includes('Disk Space Freed:'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('Disk Space  Freed'))).toBe(false);
    });

    it('should display resource list correctly', () => {
      const mockResources = [
        { name: 'container1', type: 'container', size: 1048576 },
        { name: 'image1', type: 'image', size: 2097152 },
        { name: 'volume1', type: 'volume', size: 524288 }
      ];

      (cli as any).displayResourceList(mockResources);

      expect(consoleOutput.some(line => line.includes('Found 3 unused resources'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('CONTAINER'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('IMAGE'))).toBe(true);
      expect(consoleOutput.some(line => line.includes('VOLUME'))).toBe(true);
    });

    it('should display empty resource list message', () => {
      (cli as any).displayResourceList([]);

      expect(consoleOutput.some(line => line.includes('No unused resources found!'))).toBe(true);
    });
  });
});
