/**
 * Core type definitions for Proxmox Cleanup System
 */

// Resource Types
export type ResourceType = 'container' | 'image' | 'volume' | 'network';

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  size: number;
  createdAt?: Date;
  lastUsed?: Date;
  tags: string[];
}

/**
 * Mirrors the Docker Engine's container `State` values, plus `unknown` for one
 * this version doesn't recognise.
 */
export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'exited'
  | 'removing'
  | 'dead'
  | 'unknown';

export interface ContainerResource extends Resource {
  type: 'container';
  status: ContainerStatus;
  imageId: string;
  volumes: string[];
  /** Names of the networks this container is attached to. */
  networks: string[];
}

export interface ImageResource extends Resource {
  type: 'image';
  repository: string;
  tag: string;
  usedByContainers: string[];
}

export interface VolumeResource extends Resource {
  type: 'volume';
  mountPoint: string;
  usedByContainers: string[];
}

export interface NetworkResource extends Resource {
  type: 'network';
  driver: string;
  connectedContainers: string[];
}

// Configuration Types
export interface ProxmoxConfig {
  host: string;
  token: string;
}

export interface CleanupOptions {
  dryRun: boolean;
  resourceTypes: ResourceType[];
  protectedPatterns: string[];
  backupEnabled: boolean;
  backupPath: string;
  minAge?: string;
  /** Backup files to keep; older ones are pruned. */
  keepBackups?: number;
}

export interface ReportingOptions {
  verbose: boolean;
  logPath: string;
  /** Report/summary pairs to keep; older ones are pruned. */
  keepReports?: number;
}

export interface CleanupConfig {
  proxmox: ProxmoxConfig;
  cleanup: CleanupOptions;
  reporting: ReportingOptions;
}

// Result Types
export interface CleanupError {
  type: ErrorType;
  resource?: Resource;
  message: string;
  timestamp: Date;
  recoverable: boolean;
}

export type ErrorType =
  | 'authentication'
  | 'network'
  | 'permission'
  | 'resource_in_use'
  | 'resource_not_found'
  | 'filesystem'
  | 'unknown';

export interface CleanupResult {
  removed: Resource[];
  skipped: Resource[];
  errors: CleanupError[];
  skippedUnknownAge?: Resource[];
  diskSpaceFreed: number;
  executionTime: number;
}

// Backup Types
export interface Backup {
  timestamp: Date;
  resources: Resource[];
  metadata: {
    proxmoxHost: string;
    totalSize: number;
    resourceCount: number;
  };
}

export interface BackupResult {
  success: boolean;
  backupPath: string;
  error?: string;
}

// Report Types
export interface Report {
  timestamp: Date;
  mode: 'dry-run' | 'cleanup';
  summary: {
    resourcesScanned: number;
    resourcesRemoved: number;
    diskSpaceFreed: number;
    executionTime: number;
  };
  details: {
    removed: Resource[];
    skipped: Resource[];
    errors: CleanupError[];
    skippedUnknownAge?: Resource[];
  };
}

/** A failed removal, with the classified reason. */
export interface CleanupErrorDetail {
  resource: Resource;
  type: ErrorType;
  error: string;
}
