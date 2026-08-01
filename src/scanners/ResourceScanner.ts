import {
  ContainerResource,
  ContainerStatus,
  ImageResource,
  VolumeResource,
  NetworkResource,
  Resource,
  CleanupErrorDetail
} from '../types';
import { IResourceScanner } from '../interfaces';
import { IDockerClient } from '../interfaces';
import { ResourceFilter } from '../utils/ResourceFilter';
import { errorMessage, errorType } from '../utils/errors';

/**
 * States safe to remove: dormant and not mid-transition.
 *
 * An allow-list, not `!== 'running'`, so an unrecognised state fails safe
 * rather than reading as removable.
 */
const REMOVABLE_CONTAINER_STATES: ReadonlySet<ContainerStatus> = new Set<ContainerStatus>([
  'exited',
  'created',
  'dead'
]);

/** Docker's built-ins, never removable. */
const DEFAULT_NETWORKS: ReadonlySet<string> = new Set(['bridge', 'host', 'none']);

/** Reasons shown to the user when a container is left alone. */
const LIVE_CONTAINER_REASONS: Partial<Record<ContainerStatus, string>> = {
  running: 'container is running',
  paused: 'container is paused — still live, resume or stop it first',
  restarting: 'container is restarting — still live',
  removing: 'container is already being removed by Docker',
  unknown: 'container reported a state this version does not recognise'
};

/**
 * Resource scanner implementation
 * Identifies unused Docker resources
 */
export class ResourceScanner implements IResourceScanner {
  private dockerClient: IDockerClient;
  private resourceFilter: ResourceFilter;
  private dryRun: boolean;

  constructor(dockerClient: IDockerClient, protectedPatterns: string[] = [], dryRun: boolean = false) {
    this.dockerClient = dockerClient;
    this.resourceFilter = new ResourceFilter(protectedPatterns);
    this.dryRun = dryRun;
  }

  /** Unused containers: dormant and not protected. */
  async scanContainers(): Promise<ContainerResource[]> {
    const containers = await this.dockerClient.listContainers(true);
    const unused = containers.filter(c => REMOVABLE_CONTAINER_STATES.has(c.status));
    return this.resourceFilter.filterProtected(unused);
  }

  /**
   * Scan for unused images (not referenced by any container, running or stopped).
   */
  async scanImages(): Promise<ImageResource[]> {
    const [containers, images] = await Promise.all([
      this.dockerClient.listContainers(true),
      this.dockerClient.listImages()
    ]);

    const imagesWithUsage = images
      .map(image => ({
        ...image,
        usedByContainers: containers
          .filter(c => c.imageId === image.id)
          .map(c => c.id)
      }))
      .filter(image => image.usedByContainers.length === 0);

    return this.resourceFilter.filterProtected(imagesWithUsage);
  }

  /**
   * Scan for unused volumes (not mounted by any container, running or stopped).
   */
  async scanVolumes(): Promise<VolumeResource[]> {
    const [containers, volumes] = await Promise.all([
      this.dockerClient.listContainers(true),
      this.dockerClient.listVolumes()
    ]);

    const mountedNames = this.collectNames(containers, c => c.volumes);

    const volumesWithUsage = volumes
      .map(volume => ({
        ...volume,
        usedByContainers: containers
          .filter(c => c.volumes.includes(volume.name))
          .map(c => c.id)
      }))
      .filter(volume => !mountedNames.has(volume.name));

    return this.resourceFilter.filterProtected(volumesWithUsage);
  }

  /**
   * Unused networks: nothing attached, excluding Docker's built-ins.
   * Attachment comes from the containers, since the network list omits it.
   */
  async scanNetworks(): Promise<NetworkResource[]> {
    const [allNetworks, containers] = await Promise.all([
      this.dockerClient.listNetworks(),
      this.dockerClient.listContainers(true)
    ]);

    const attachedNames = this.collectNames(containers, c => c.networks);

    const unusedNetworks = allNetworks
      .filter(network => !DEFAULT_NETWORKS.has(network.name) && !attachedNames.has(network.name))
      .map(network => ({
        ...network,
        connectedContainers: this.containersOn(containers, network.name)
      }));

    return this.resourceFilter.filterProtected(unusedNetworks);
  }

  /** Non-empty names the containers reference, via `pick`. */
  private collectNames(
    containers: ContainerResource[],
    pick: (container: ContainerResource) => string[]
  ): Set<string> {
    const names = new Set<string>();
    for (const container of containers) {
      for (const name of pick(container)) {
        if (name) names.add(name);
      }
    }
    return names;
  }

  /** Ids of the containers attached to a given network. */
  private containersOn(containers: ContainerResource[], networkName: string): string[] {
    return containers.filter(c => c.networks.includes(networkName)).map(c => c.id);
  }

  /**
   * Whether a resource is still in use, against a list fetched at cleanup time.
   *
   * Re-derives from `liveContainers` rather than the status captured during the
   * scan, so it can catch something that changed in between.
   */
  async isResourceInUse(resource: Resource, containers?: ContainerResource[]): Promise<boolean> {
    const liveContainers = containers ?? await this.dockerClient.listContainers(true);

    switch (resource.type) {
    case 'container': {
      const live = liveContainers.find(c => c.id === resource.id);
      // Already gone: let the removal 404.
      if (!live) return false;
      return !REMOVABLE_CONTAINER_STATES.has(live.status);
    }
    case 'image': {
      const image = resource as ImageResource;
      return liveContainers.some(c => c.imageId === image.id);
    }
    case 'volume': {
      const volume = resource as VolumeResource;
      return liveContainers.some(c => c.volumes.includes(volume.name));
    }
    case 'network': {
      const network = resource as NetworkResource;
      return liveContainers.some(c => c.networks.includes(network.name));
    }
    default:
      return false;
    }
  }

  /** Why a resource was skipped, in the user's terms. */
  skipReason(resource: Resource, containers: ContainerResource[]): string {
    if (resource.type === 'container') {
      const live = containers.find(c => c.id === resource.id);
      if (live) {
        return LIVE_CONTAINER_REASONS[live.status] ?? 'container is still in use';
      }
    }
    return 'still in use';
  }

  /**
   * Remove the given resources, or report what would go in dry-run.
   * Fetches the container list once and reuses it for every in-use check.
   */
  async performCleanup(resources: Resource[]): Promise<{
    removed: Resource[];
    skipped: Resource[];
    skipReasons: Map<string, string>;
    errors: CleanupErrorDetail[];
  }> {
    const removed: Resource[] = [];
    const skipped: Resource[] = [];
    const skipReasons = new Map<string, string>();
    const errors: CleanupErrorDetail[] = [];

    const containers = await this.dockerClient.listContainers(true);

    for (const resource of resources) {
      try {
        if (await this.isResourceInUse(resource, containers)) {
          skipped.push(resource);
          skipReasons.set(resource.id, this.skipReason(resource, containers));
          continue;
        }

        if (this.dryRun) {
          removed.push(resource);
          continue;
        }

        switch (resource.type) {
        case 'container':
          await this.dockerClient.removeContainer(resource.id);
          removed.push(resource);
          break;
        case 'image':
          await this.dockerClient.removeImage(resource.id);
          removed.push(resource);
          break;
        case 'volume':
          await this.dockerClient.removeVolume(resource.id);
          removed.push(resource);
          break;
        case 'network':
          await this.dockerClient.removeNetwork(resource.id);
          removed.push(resource);
          break;
        default:
          skipped.push(resource);
          skipReasons.set(resource.id, 'unrecognised resource type');
        }
      } catch (error) {
        errors.push({
          resource,
          type: errorType(error),
          error: errorMessage(error)
        });
      }
    }

    return { removed, skipped, skipReasons, errors };
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }
}
