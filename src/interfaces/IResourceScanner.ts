import {
  ContainerResource,
  ImageResource,
  VolumeResource,
  NetworkResource,
  Resource,
  CleanupErrorDetail
} from '../types';

/**
 * Interface for resource scanning operations
 */
export interface IResourceScanner {
  /**
   * Scan for unused containers
   */
  scanContainers(): Promise<ContainerResource[]>;

  /**
   * Scan for unused images
   */
  scanImages(): Promise<ImageResource[]>;

  /**
   * Scan for unused volumes
   */
  scanVolumes(): Promise<VolumeResource[]>;

  /**
   * Scan for unused networks
   */
  scanNetworks(): Promise<NetworkResource[]>;

  /**
   * Check if a resource is currently in use
   */
  isResourceInUse(resource: Resource, containers?: ContainerResource[]): Promise<boolean>;

  /**
   * Perform cleanup operation with dry-run support.
   * `skipReasons` is keyed by resource id.
   */
  performCleanup(resources: Resource[]): Promise<{
    removed: Resource[];
    skipped: Resource[];
    skipReasons: Map<string, string>;
    errors: CleanupErrorDetail[];
  }>;

  /**
   * Get dry-run status
   */
  isDryRun(): boolean;

  /**
   * Set dry-run mode
   */
  setDryRun(dryRun: boolean): void;
}
