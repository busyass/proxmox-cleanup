#!/usr/bin/env node

import { Command } from 'commander';
import { CleanupOrchestrator } from '../orchestrators/CleanupOrchestrator';
import { DockerClient } from '../clients/DockerClient';
import { ResourceScanner } from '../scanners/ResourceScanner';
import { BackupManager } from '../managers/BackupManager';
import { Reporter } from '../reporters/Reporter';
import { ProxmoxClient } from '../clients/ProxmoxClient';
import { CleanupConfig, ResourceType, Resource, Report, CleanupError } from '../types';
import { SizeCalculator } from '../utils/SizeCalculator';
import { ResourceFilter } from '../utils/ResourceFilter';
import { errorMessage } from '../utils/errors';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CLI options interface
 */
interface CliOptions {
  dryRun?: boolean;
  types?: string;
  protect?: string;
  backup?: boolean;
  backupPath?: string;
  config?: string;
  verbose?: boolean;
  logPath?: string;
  proxmoxHost?: string;
  proxmoxToken?: string;
  json?: boolean;
  olderThan?: string;
}

/**
 * CLI interface for Proxmox Cleanup System
 */
class ProxmoxCleanupCLI {
  private program: Command;

  constructor() {
    this.program = new Command();
    this.setupCommands();
  }

  /**
   * Read the CLI version from the package.json shipped alongside dist/.
   * Walks up from __dirname because the compiled file lives at dist/cli/index.js
   * but is also run directly from src/cli/index.ts during tests.
   */
  private readPackageVersion(): string {
    const candidates = [
      path.join(__dirname, '..', '..', 'package.json'),
      path.join(__dirname, '..', '..', '..', 'package.json')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg && typeof pkg.version === 'string') return pkg.version;
      }
    }
    return '0.0.0';
  }

  /**
   * Setup CLI commands and options
   */
  private setupCommands(): void {
    this.program
      .name('proxmox-cleanup')
      .description('Automated cleanup tool for unused Docker resources on Proxmox infrastructure')
      .version(this.readPackageVersion());

    // Main cleanup command
    this.program
      .command('cleanup')
      .description('Execute cleanup of unused Docker resources')
      .option('-d, --dry-run', 'Preview what would be removed without actually removing anything')
      .option('-t, --types <types>', 'Resource types to clean: containers,images,volumes,networks, or all (default: all)')
      .option('-p, --protect <patterns>', 'Comma-separated list of protection patterns (wildcards supported)', '')
      .option('-b, --backup', 'Create backup before cleanup (enabled by default)')
      .option('--no-backup', 'Disable backup creation')
      .option('--backup-path <path>', 'Custom backup directory path (default: ./backups)')
      .option('-c, --config <path>', 'Path to configuration file')
      .option('-v, --verbose', 'Enable verbose logging')
      .option('--log-path <path>', 'Custom log directory path (default: ./logs)')
      .option('--proxmox-host <host>', 'Proxmox host address')
      .option('--proxmox-token <token>', 'Proxmox API token (format: user@realm:password)')
      .option('--older-than <duration>', 'Only act on resources created before now minus this duration (e.g. 7d, 12h)')
      .option('--json', 'Output machine-readable JSON only (suppresses human output)')
      .action(async (options) => {
        try {
          await this.executeCleanup(options);
        } catch (error) {
          if (options.json) {
            this.emitJson({ error: { message: errorMessage(error) } });
          } else {
            console.error('❌ Cleanup failed:', errorMessage(error));
          }
          process.exitCode = 1;
        }
      });

    // Dry-run command (shortcut)
    this.program
      .command('dry-run')
      .description('Preview what would be removed without actually removing anything')
      .option('-t, --types <types>', 'Resource types to scan: containers,images,volumes,networks, or all (default: all)')
      .option('-p, --protect <patterns>', 'Comma-separated list of protection patterns (wildcards supported)', '')
      .option('-c, --config <path>', 'Path to configuration file')
      .option('-v, --verbose', 'Enable verbose logging')
      .option('--log-path <path>', 'Custom log directory path (default: ./logs)')
      .option('--proxmox-host <host>', 'Proxmox host address')
      .option('--proxmox-token <token>', 'Proxmox API token (format: user@realm:password)')
      .option('--older-than <duration>', 'Only act on resources created before now minus this duration (e.g. 7d, 12h)')
      .option('--json', 'Output machine-readable JSON only (suppresses human output)')
      .action(async (options) => {
        try {
          await this.executeDryRun(options);
        } catch (error) {
          if (options.json) {
            this.emitJson({ error: { message: errorMessage(error) } });
          } else {
            console.error('❌ Dry-run failed:', errorMessage(error));
          }
          process.exitCode = 1;
        }
      });

    // List resources command
    this.program
      .command('list')
      .description('List unused Docker resources without removing them')
      .option('-t, --types <types>', 'Resource types to list: containers,images,volumes,networks, or all (default: all)')
      .option('-p, --protect <patterns>', 'Comma-separated list of protection patterns (wildcards supported)', '')
      .option('-c, --config <path>', 'Path to configuration file')
      .option('--older-than <duration>', 'Only act on resources created before now minus this duration (e.g. 7d, 12h)')
      .option('--json', 'Output machine-readable JSON only (suppresses human output)')
      .action(async (options) => {
        try {
          await this.listResources(options);
        } catch (error) {
          if (options.json) {
            this.emitJson({ error: { message: errorMessage(error) } });
          } else {
            console.error('❌ List failed:', errorMessage(error));
          }
          process.exitCode = 1;
        }
      });

    // Config validation command
    this.program
      .command('validate-config')
      .description('Validate configuration file')
      .option('-c, --config <path>', 'Path to configuration file', './config.json')
      .option('--json', 'Output machine-readable JSON only (suppresses human output)')
      .action(async (options) => {
        try {
          await this.validateConfig(options);
        } catch (error) {
          if (options.json) {
            this.emitJson({ error: { message: errorMessage(error) } });
          } else {
            console.error('❌ Config validation failed:', errorMessage(error));
          }
          process.exitCode = 1;
        }
      });
  }

  /**
   * Emit JSON to stdout
   */
  private emitJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
  }

  /**
   * Execute cleanup operation
   */
  private async executeCleanup(options: CliOptions): Promise<void> {
    if (!options.json) {
      console.log('🚀 Starting Proxmox Docker cleanup...\n');
    }

    const config = await this.loadConfig(options);
    const orchestrator = await this.createOrchestrator(config, options);

    const report = await orchestrator.executeCleanup();

    if (options.json) {
      this.emitJson(report);
    } else {
      this.displayReport(report);
    }

    if (report.details.errors.length > 0) {
      // exitCode, not exit(): exit() would truncate buffered --json output.
      process.exitCode = 1;
    }
  }

  /**
   * Execute dry-run operation
   */
  private async executeDryRun(options: CliOptions): Promise<void> {
    if (!options.json) {
      console.log('🔍 Starting dry-run preview...\n');
    }

    const config = await this.loadConfig(options);
    const orchestrator = await this.createOrchestrator(config, options);

    const report = await orchestrator.executeDryRun();

    if (options.json) {
      this.emitJson(report);
    } else {
      this.displayReport(report);
    }
  }

  /**
   * List unused resources
   */
  private async listResources(options: CliOptions): Promise<void> {
    if (!options.json) {
      console.log('📋 Listing unused Docker resources...\n');
    }

    const config = await this.loadConfig(options);
    const orchestrator = await this.createOrchestrator(config, options);

    // Same pipeline as cleanup, so the listing cannot diverge from it.
    const { resources, skippedUnknownAge } = await orchestrator.listUnused();

    if (options.json) {
      const byType = resources.reduce<Record<string, { count: number; size: number }>>((acc, r) => {
        acc[r.type] = acc[r.type] || { count: 0, size: 0 };
        acc[r.type].count += 1;
        acc[r.type].size += r.size;
        return acc;
      }, {});
      this.emitJson({
        resources,
        skippedUnknownAge,
        summary: {
          count: resources.length,
          totalSize: SizeCalculator.calculateTotalSize(resources),
          skippedUnknownAgeCount: skippedUnknownAge.length,
          byType
        }
      });
      return;
    }

    this.displayResourceList(resources, skippedUnknownAge);
  }

  /**
   * Validate configuration file
   */
  private async validateConfig(options: CliOptions): Promise<void> {
    const checks: Record<string, boolean | null> = {
      structure: false,
      proxmox: null,
      docker: false
    };

    if (!options.json) {
      console.log('✅ Validating configuration...\n');
    }

    try {
      const config = await this.loadConfig(options);

      // Basic validation
      this.validateConfigStructure(config);
      checks.structure = true;

      // Test Proxmox connection if configured
      if (config.proxmox.host && config.proxmox.token) {
        if (!options.json) {
          console.log('🔗 Testing Proxmox connection...');
        }
        const proxmoxClient = new ProxmoxClient(config.proxmox);

        await proxmoxClient.authenticate();
        checks.proxmox = true;
        if (!options.json) {
          console.log('✅ Proxmox connection successful');
        }
      }

      // Test Docker connection
      if (!options.json) {
        console.log('🐳 Testing Docker connection...');
      }
      const dockerClient = new DockerClient();
      await dockerClient.connect();
      checks.docker = true;
      if (!options.json) {
        console.log('✅ Docker connection successful');
      }

      if (options.json) {
        this.emitJson({ valid: true, checks });
      } else {
        console.log('\n🎉 Configuration is valid!');
      }

    } catch (error) {
      // Re-thrown as-is: the command handler prefixes the message and emits the
      // JSON error, so wrapping here only duplicated the prefix.
      throw error;
    }
  }

  /**
   * Load configuration from file or CLI options
   */
  private async loadConfig(options: CliOptions): Promise<CleanupConfig> {
    let config: CleanupConfig;

    if (options.config) {
      // A named file that isn't there is a mistake, not a request for defaults:
      // falling back would run with none of the user's protection patterns.
      if (!fs.existsSync(options.config)) {
        throw new Error(
          `Configuration file not found: ${options.config}. ` +
          'Check the path, or omit --config to use built-in defaults.'
        );
      }
      const configContent = fs.readFileSync(options.config, 'utf8');
      config = JSON.parse(configContent);
    } else {
      // Create default config
      config = this.createDefaultConfig();
    }

    // Override with CLI options
    this.applyCliOptions(config, options);

    return config;
  }

  /**
   * Create default configuration
   */
  private createDefaultConfig(): CleanupConfig {
    return {
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
    };
  }

  /**
   * Apply CLI options to configuration
   */
  private applyCliOptions(config: CleanupConfig, options: CliOptions): void {
    // Dry-run mode
    if (options.dryRun) {
      config.cleanup.dryRun = true;
    }

    // `all` is explicit: it widens a config that narrowed the set.
    if (options.types) {
      config.cleanup.resourceTypes = this.parseResourceTypes(options.types);
    }

    // Protection patterns
    if (options.protect) {
      config.cleanup.protectedPatterns = options.protect.split(',').map(p => p.trim());
    }

    // Backup settings
    if (options.backup !== undefined) {
      config.cleanup.backupEnabled = options.backup;
    }
    if (options.backupPath) {
      config.cleanup.backupPath = options.backupPath;
    }

    // Reporting settings
    if (options.verbose) {
      config.reporting.verbose = true;
    }
    if (options.logPath) {
      config.reporting.logPath = options.logPath;
    }

    // Proxmox settings
    if (options.proxmoxHost) {
      config.proxmox.host = options.proxmoxHost;
    }
    if (options.proxmoxToken) {
      config.proxmox.token = options.proxmoxToken;
    }

    // Age filtering
    if (options.olderThan) {
      config.cleanup.minAge = options.olderThan;
    }
  }

  /**
   * Refuse to run on a pattern that cannot match: the user asked for a safety
   * net and would otherwise get none, silently.
   */
  private assertProtectionPatternsUsable(patterns: string[]): void {
    const problems = new ResourceFilter(patterns).findProblems();
    if (problems.length === 0) return;

    const detail = problems
      .map(({ pattern, reason }) => `  "${pattern}" — ${reason}`)
      .join('\n');

    throw new Error(
      `These protection patterns cannot match anything:\n${detail}\n` +
      'Fix or remove them before running, so nothing is deleted that you meant to keep.'
    );
  }

  /**
   * Parse resource types from string
   */
  private parseResourceTypes(typesString: string): ResourceType[] {
    // Empty means no type filter.
    if (typesString.trim().toLowerCase() === 'all') return [];

    const typeMapping: Record<string, ResourceType> = {
      'container': 'container',
      'containers': 'container',
      'image': 'image',
      'images': 'image',
      'volume': 'volume',
      'volumes': 'volume',
      'network': 'network',
      'networks': 'network'
    };

    const types = typesString.split(',').map(t => t.trim().toLowerCase());

    const parsedTypes: ResourceType[] = [];
    for (const type of types) {
      const mappedType = typeMapping[type];
      if (mappedType) {
        parsedTypes.push(mappedType);
      } else {
        throw new Error(`Invalid resource type: ${type}. Valid types: ${Object.keys(typeMapping).join(', ')}`);
      }
    }

    return parsedTypes;
  }

  /**
   * Create orchestrator with all dependencies
   */
  private async createOrchestrator(config: CleanupConfig, options: CliOptions): Promise<CleanupOrchestrator> {
    this.assertProtectionPatternsUsable(config.cleanup.protectedPatterns);

    // Create Docker client
    const dockerClient = new DockerClient();
    await dockerClient.connect();

    // Create resource filter and scanner
    const resourceScanner = new ResourceScanner(dockerClient, config.cleanup.protectedPatterns);
    resourceScanner.setDryRun(config.cleanup.dryRun);

    // Create backup manager
    const backupManager = new BackupManager(
      config.cleanup.backupPath,
      config.proxmox.host,
      config.cleanup.keepBackups
    );

    // Create reporter
    const reporter = new Reporter(
      config.reporting.logPath,
      options.json === true,
      config.reporting.keepReports
    );

    return new CleanupOrchestrator(
      dockerClient,
      resourceScanner,
      backupManager,
      reporter,
      config
    );
  }

  /**
   * Display cleanup report
   */
  private displayReport(report: Report): void {
    // From the report, so no caller can contradict what actually ran.
    const isDryRun = report.mode === 'dry-run';
    const mode = isDryRun ? 'DRY-RUN' : 'CLEANUP';
    const emoji = isDryRun ? '🔍' : '🧹';

    console.log(`\n${emoji} ${mode} REPORT`);
    console.log('='.repeat(50));

    console.log(`📊 Resources Scanned: ${report.summary.resourcesScanned}`);
    console.log(`${isDryRun ? '📋' : '🗑️'} Resources${isDryRun ? ' Would Be' : ''} Removed: ${report.summary.resourcesRemoved}`);
    console.log(`💾 Disk Space ${isDryRun ? 'Would Be ' : ''}Freed: ${SizeCalculator.formatBytes(report.summary.diskSpaceFreed)}`);
    console.log(`⏱️ Execution Time: ${report.summary.executionTime}ms`);

    if (report.details.skipped.length > 0) {
      console.log(`⏭️ Resources Skipped (still in use or protected): ${report.details.skipped.length}`);
    }

    if (report.details.skippedUnknownAge && report.details.skippedUnknownAge.length > 0) {
      console.log(`🕓 Skipped (no creation time from Docker, --older-than not applied): ${report.details.skippedUnknownAge.length}`);
    }

    if (report.details.errors.length > 0) {
      console.log(`❌ Errors: ${report.details.errors.length}`);
      report.details.errors.forEach((error: CleanupError) => {
        console.log(`   • ${error.message}`);
      });
    }

    // Show detailed resource list if verbose or dry-run
    if (isDryRun || report.details.removed.length <= 10) {
      if (report.details.removed.length > 0) {
        console.log(`\n📋 ${isDryRun ? 'Resources to be removed:' : 'Removed resources:'}`);
        report.details.removed.forEach((resource: Resource) => {
          const icon = this.getResourceIcon(resource.type);
          console.log(`   ${icon} ${resource.name} (${resource.type}) - ${SizeCalculator.describeSize(resource)}`);
        });
      }
    }

    console.log('\n' + '='.repeat(50));

    if (isDryRun) {
      console.log('💡 This was a dry-run. No resources were actually removed.');
      console.log('💡 Run without --dry-run to perform actual cleanup.');
    } else {
      console.log('✅ Cleanup completed successfully!');
    }
  }

  /**
   * Display resource list
   */
  private displayResourceList(resources: Resource[], skippedUnknownAge: Resource[] = []): void {
    if (resources.length === 0) {
      console.log('🎉 No unused resources found!');
      this.displayUnknownAgeNote(skippedUnknownAge);
      return;
    }

    console.log(`📋 Found ${resources.length} unused ${this.plural(resources.length, 'resource')}:\n`);

    // Group by type
    const grouped = resources.reduce<Record<string, Resource[]>>((acc, resource) => {
      if (!acc[resource.type]) {
        acc[resource.type] = [];
      }
      acc[resource.type].push(resource);
      return acc;
    }, {});

    // Display each type
    Object.entries(grouped).forEach(([type, typeResources]) => {
      const icon = this.getResourceIcon(type);
      const count = typeResources.length;
      const sizeLabel = SizeCalculator.hasKnownSize(typeResources[0])
        ? SizeCalculator.formatBytes(SizeCalculator.calculateTotalSize(typeResources))
        : SizeCalculator.describeSize(typeResources[0]);

      console.log(`${icon} ${type.toUpperCase()} (${count} ${this.plural(count, 'item')}, ${sizeLabel})`);

      typeResources.forEach((resource: Resource) => {
        console.log(`   • ${resource.name} - ${SizeCalculator.describeSize(resource)}`);
      });

      console.log('');
    });

    const totalSize = SizeCalculator.calculateTotalSize(resources);
    console.log(`💾 Total reclaimable space: ${SizeCalculator.formatBytes(totalSize)}`);
    if (resources.some(r => !SizeCalculator.hasKnownSize(r))) {
      console.log('   (volume and network sizes aren\'t reported by the Docker Engine)');
    }
    this.displayUnknownAgeNote(skippedUnknownAge);
  }

  /** Report resources the age filter couldn't judge, rather than dropping them. */
  private displayUnknownAgeNote(skippedUnknownAge: Resource[]): void {
    if (skippedUnknownAge.length === 0) return;
    console.log(
      `\n🕓 ${skippedUnknownAge.length} ${this.plural(skippedUnknownAge.length, 'resource')} ` +
      'skipped: no creation time from Docker, so --older-than could not be applied'
    );
  }

  /** Pluralise for a count. */
  private plural(count: number, noun: string): string {
    return count === 1 ? noun : `${noun}s`;
  }

  /**
   * Get emoji icon for resource type
   */
  private getResourceIcon(type: string): string {
    const icons: Record<string, string> = {
      container: '📦',
      image: '🖼️',
      volume: '💾',
      network: '🌐'
    };
    return icons[type] || '📄';
  }

  /**
   * Validate configuration structure
   */
  private validateConfigStructure(config: CleanupConfig): void {
    if (!config.proxmox || !config.cleanup || !config.reporting) {
      throw new Error('Invalid configuration structure. Missing required sections.');
    }

    if (config.cleanup.resourceTypes) {
      const validTypes: ResourceType[] = ['container', 'image', 'volume', 'network'];
      const invalidTypes = config.cleanup.resourceTypes.filter(type => !validTypes.includes(type));
      if (invalidTypes.length > 0) {
        throw new Error(`Invalid resource types in config: ${invalidTypes.join(', ')}`);
      }
    }
  }

  /**
   * Run the CLI
   */
  public async run(): Promise<void> {
    await this.program.parseAsync(process.argv);
  }
}

/**
 * Entry point. Exported so `bin/proxmox-cleanup` can call it explicitly: the
 * shim loads this module with `require`, which makes `require.main` the shim
 * rather than this file, so a `require.main === module` guard never fires and
 * every command silently did nothing.
 */
function main(): void {
  const cli = new ProxmoxCleanupCLI();
  cli.run().catch(error => {
    console.error('❌ CLI Error:', errorMessage(error));
    process.exitCode = 1;
  });
}

// Also run when executed directly (node dist/cli/index.js).
if (require.main === module) {
  main();
}

export { ProxmoxCleanupCLI, main };
