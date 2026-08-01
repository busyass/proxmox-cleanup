import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BackupManager } from '../BackupManager';
import { Resource } from '../../types';

describe('BackupManager Error Handling', () => {
  it('should handle backup creation failure gracefully', async () => {
    const backupManager = new BackupManager('./test-backups-fail');

    // Mock the ensureBackupDirectory method to simulate failure
    const originalEnsureBackupDirectory = (backupManager as any).ensureBackupDirectory;
    (backupManager as any).ensureBackupDirectory = jest.fn().mockRejectedValue(new Error('Permission denied'));

    const testResources: Resource[] = [
      {
        id: 'test-123',
        name: 'test-resource',
        type: 'container',
        size: 1000,
        createdAt: new Date(),
        tags: []
      }
    ];

    const result = await backupManager.createBackup(testResources);

    // Property: Backup should fail gracefully when directory creation fails
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('Failed to create backup');

    // Restore original method
    (backupManager as any).ensureBackupDirectory = originalEnsureBackupDirectory;
  });

  it('should handle file read errors when loading backup', async () => {
    const backupManager = new BackupManager('./test-backups');

    // Try to load non-existent backup
    await expect(
      backupManager.loadBackup('/nonexistent/backup.json')
    ).rejects.toThrow();
  });

  it('should handle invalid JSON in backup file', async () => {
    const testBackupDir = './test-backups-invalid';
    const backupManager = new BackupManager(testBackupDir);

    try {
      // Create directory and invalid backup file
      await fs.mkdir(testBackupDir, { recursive: true });
      const invalidBackupPath = `${testBackupDir}/invalid.backup.json`;
      await fs.writeFile(invalidBackupPath, 'invalid json content', 'utf-8');

      // Try to load invalid backup
      await expect(
        backupManager.loadBackup(invalidBackupPath)
      ).rejects.toThrow();
    } finally {
      // Cleanup
      try {
        await fs.unlink(`${testBackupDir}/invalid.backup.json`);
        await fs.rmdir(testBackupDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
});

describe('BackupManager retention and metadata', () => {
  const resources: Resource[] = [
    { id: 'r1', name: 'r1', type: 'image', size: 500, tags: [] }
  ];
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcx-backup-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records the configured Proxmox host, not just an env var', async () => {
    const manager = new BackupManager(dir, 'pve.example.com');

    const result = await manager.createBackup(resources);
    const backup = await manager.loadBackup(result.backupPath);

    expect(backup.metadata.proxmoxHost).toBe('pve.example.com');
    expect(backup.metadata.totalSize).toBe(500);
    expect(backup.metadata.resourceCount).toBe(1);
  });

  it('falls back to PROXMOX_HOST, then to "unknown"', async () => {
    const original = process.env.PROXMOX_HOST;
    try {
      process.env.PROXMOX_HOST = 'env-host';
      const viaEnv = new BackupManager(dir);
      const envResult = await viaEnv.createBackup(resources);
      expect((await viaEnv.loadBackup(envResult.backupPath)).metadata.proxmoxHost).toBe('env-host');

      delete process.env.PROXMOX_HOST;
      const viaNothing = new BackupManager(dir);
      const bareResult = await viaNothing.createBackup(resources);
      expect((await viaNothing.loadBackup(bareResult.backupPath)).metadata.proxmoxHost).toBe('unknown');
    } finally {
      if (original === undefined) delete process.env.PROXMOX_HOST;
      else process.env.PROXMOX_HOST = original;
    }
  });

  it('prunes older backups so the directory stays bounded', async () => {
    const manager = new BackupManager(dir, 'pve.local', 2);

    for (let i = 0; i < 4; i++) {
      await manager.createBackup(resources);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const files = (await fs.readdir(dir)).filter(f => f.startsWith('cleanup_'));
    expect(files).toHaveLength(2);
  });

  it('writes distinct files even for backups in the same millisecond', async () => {
    // A timestamp alone collides readily, and the second backup would
    // overwrite the first, losing the record of what that run deleted.
    const manager = new BackupManager(dir, 'pve.local');

    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      paths.push((await manager.createBackup(resources)).backupPath);
    }

    expect(new Set(paths).size).toBe(5);
    expect((await fs.readdir(dir)).filter(f => f.startsWith('cleanup_'))).toHaveLength(5);
  });
});
