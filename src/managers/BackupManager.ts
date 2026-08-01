import * as fs from 'fs/promises';
import * as path from 'path';
import { Backup, BackupResult, Resource } from '../types';
import { IBackupManager } from '../interfaces';
import { errorMessage } from '../utils/errors';
import { SizeCalculator } from '../utils/SizeCalculator';
import { pruneOldest } from '../utils/retention';

/** Default retained backups. */
const DEFAULT_KEEP_BACKUPS = 30;

const BACKUP_PREFIX = 'cleanup_';

/**
 * Backup manager implementation
 * Handles creation and management of resource metadata backups
 */
export class BackupManager implements IBackupManager {
  private backupDirectory: string;
  private proxmoxHost: string;
  private keepBackups: number;
  /** Distinguishes backups within the same millisecond. */
  private backupsWritten = 0;

  constructor(
    backupDirectory: string = './backups',
    proxmoxHost: string = '',
    keepBackups: number = DEFAULT_KEEP_BACKUPS
  ) {
    this.backupDirectory = backupDirectory;
    this.proxmoxHost = proxmoxHost;
    this.keepBackups = keepBackups;
  }

  /**
   * Create a backup of resources
   */
  async createBackup(resources: Resource[]): Promise<BackupResult> {
    try {
      // Ensure backup directory exists
      await this.ensureBackupDirectory();

      // Create backup object
      const backup: Backup = {
        timestamp: new Date(),
        resources,
        metadata: {
          // PROXMOX_HOST kept as a fallback for anyone already using it.
          proxmoxHost: this.proxmoxHost || process.env.PROXMOX_HOST || 'unknown',
          totalSize: SizeCalculator.calculateTotalSize(resources),
          resourceCount: resources.length
        }
      };

      // Generate backup filename with timestamp
      const filename = this.generateBackupFilename();
      const backupPath = path.join(this.backupDirectory, filename);

      // Save backup to file
      await this.saveBackup(backup, backupPath);

      // Nothing else prunes these.
      await pruneOldest(this.backupDirectory, BACKUP_PREFIX, this.keepBackups);

      return {
        success: true,
        backupPath
      };
    } catch (error: unknown) {
      return {
        success: false,
        backupPath: '',
        error: `Failed to create backup: ${errorMessage(error)}`
      };
    }
  }

  /**
   * Save backup to file
   */
  async saveBackup(backup: Backup, filePath: string): Promise<void> {
    try {
      const jsonContent = JSON.stringify(backup, null, 2);
      await fs.writeFile(filePath, jsonContent, 'utf-8');
    } catch (error: unknown) {
      throw new Error(`Failed to save backup to ${filePath}: ${errorMessage(error)}`);
    }
  }

  /**
   * Load backup from file
   */
  async loadBackup(filePath: string): Promise<Backup> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const backup = JSON.parse(content);

      // Convert timestamp string back to Date
      backup.timestamp = new Date(backup.timestamp);

      // Convert resource createdAt strings back to Dates
      backup.resources = backup.resources.map((r: Record<string, unknown>) => ({
        ...r,
        createdAt: r.createdAt ? new Date(r.createdAt as string) : undefined,
        lastUsed: r.lastUsed ? new Date(r.lastUsed as string) : undefined
      }));

      return backup;
    } catch (error: unknown) {
      throw new Error(`Failed to load backup from ${filePath}: ${errorMessage(error)}`);
    }
  }

  /**
   * Ensure backup directory exists
   */
  private async ensureBackupDirectory(): Promise<void> {
    await fs.mkdir(this.backupDirectory, { recursive: true });
  }

  /**
   * Timestamped filename plus a sequence number, since two backups can land in
   * the same millisecond and the second would otherwise overwrite the first.
   */
  private generateBackupFilename(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_');
    const sequence = String(++this.backupsWritten).padStart(3, '0');
    return `${BACKUP_PREFIX}${timestamp}_${sequence}.backup.json`;
  }
}
