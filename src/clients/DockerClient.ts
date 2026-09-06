import Docker from 'dockerode';
import {
  ContainerResource,
  ContainerStatus,
  ImageResource,
  VolumeResource,
  NetworkResource,
  CleanupError
} from '../types';
import { IDockerClient } from '../interfaces';
import { CleanupOperationError, isRecoverableDockerErrorType } from '../utils/errors';

/**
 * Flatten labels to the tags protection patterns match against: both the bare
 * key and `key=value`, so `tag:backup` and `tag:backup=keep` both work.
 */
function labelsToTags(labels?: Record<string, string>): string[] {
  if (!labels) return [];
  const tags: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    tags.push(key);
    if (value) tags.push(`${key}=${value}`);
  }
  return tags;
}

/**
 * Total map of the Engine's container states. Deliberately exhaustive: an
 * unrecognised state must resolve to `unknown`, not to something deletable.
 */
const CONTAINER_STATUS_BY_STATE: Record<string, ContainerStatus> = {
  created: 'created',
  running: 'running',
  paused: 'paused',
  restarting: 'restarting',
  exited: 'exited',
  removing: 'removing',
  dead: 'dead'
};

export class DockerClient implements IDockerClient {
  private docker: Docker;
  private connected: boolean = false;

  constructor(socketPath?: string) {
    // DOCKER_HOST still wins: docker-modem ignores socketPath when it resolves
    // a host from the environment.
    this.docker = new Docker({
      socketPath: socketPath || '/var/run/docker.sock'
    });
  }

  async connect(): Promise<void> {
    try {
      await this.docker.ping();
      this.connected = true;
    } catch (error) {
      this.connected = false;
      const cleanupError = this.createError('network', 'Failed to connect to Docker daemon', error);
      throw new Error(cleanupError.message);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * List all containers. `size: true` is required for SizeRw to be populated.
   */
  async listContainers(all: boolean = true): Promise<ContainerResource[]> {
    return this.listResources('containers', async () => {
      const containers = await this.docker.listContainers({ all, size: true });

      return containers.map(container => ({
        id: container.Id,
        name: container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12),
        type: 'container' as const,
        size: (container as Docker.ContainerInfo & { SizeRw?: number }).SizeRw || 0,
        createdAt: new Date(container.Created * 1000),
        tags: labelsToTags(container.Labels),
        status: this.mapContainerStatus(container.State),
        imageId: container.ImageID,
        // Named volumes only: bind mounts have no Name and would leak host paths.
        volumes: container.Mounts
          ?.filter(m => m.Type === 'volume' && m.Name)
          .map(m => m.Name as string) || [],
        // The network list endpoint stopped reporting attachment in API 1.28,
        // so it has to come from the container side.
        networks: Object.keys(container.NetworkSettings?.Networks || {})
      }));
    });
  }

  /**
   * List images. No `all: true`: that adds intermediate layers, which always
   * have descendants and so can never be removed. Dangling images are
   * final-layer and appear without it.
   */
  async listImages(): Promise<ImageResource[]> {
    return this.listResources('images', async () => {
      const images = await this.docker.listImages();

      return images.map(image => {
        const repoTag = image.RepoTags?.[0];
        const { repository, tag } = this.splitRepoTag(repoTag);

        return {
          id: image.Id,
          // Untagged images all share one name, so add a short id to tell them apart.
          name: repoTag || `<none>:<none> (${this.shortId(image.Id)})`,
          type: 'image' as const,
          size: image.Size || 0,
          createdAt: new Date(image.Created * 1000),
          tags: labelsToTags(image.Labels),
          repository,
          tag,
          usedByContainers: [] // Will be populated by scanner
        };
      });
    });
  }

  async listVolumes(): Promise<VolumeResource[]> {
    return this.listResources('volumes', async () => {
      const result = await this.docker.listVolumes();
      const volumes = result.Volumes || [];

      return volumes.map(volume => {
        const rawCreated = (volume as Docker.VolumeInspectInfo & { CreatedAt?: string }).CreatedAt;
        return {
          id: volume.Name,
          name: volume.Name,
          type: 'volume' as const,
          size: 0, // Docker API doesn't provide volume size directly
          createdAt: rawCreated ? new Date(rawCreated) : undefined,
          tags: labelsToTags(volume.Labels),
          mountPoint: volume.Mountpoint,
          usedByContainers: [] // Will be populated by scanner
        };
      });
    });
  }

  /**
   * List all networks. `connectedContainers` is left empty: the list endpoint
   * does not report attachment, so the scanner derives it from containers.
   */
  async listNetworks(): Promise<NetworkResource[]> {
    return this.listResources('networks', async () => {
      const networks = await this.docker.listNetworks();

      return networks.map(network => ({
        id: network.Id,
        name: network.Name,
        type: 'network' as const,
        size: 0, // Networks don't have size
        createdAt: network.Created ? new Date(network.Created) : undefined,
        tags: labelsToTags(network.Labels),
        driver: network.Driver,
        connectedContainers: []
      }));
    });
  }

  /**
   * Remove a container by ID. No `force`, so the Engine's 409 on a running
   * container stays a backstop rather than becoming a kill.
   */
  async removeContainer(id: string): Promise<void> {
    return this.removeResource('Container', id, () =>
      this.docker.getContainer(id).remove()
    );
  }

  /**
   * Remove an image by ID. `force` here only covers stopped-container use and
   * extra tags, which the scan has already accounted for.
   */
  async removeImage(id: string): Promise<void> {
    return this.removeResource('Image', id, () =>
      this.docker.getImage(id).remove({ force: true })
    );
  }

  async removeVolume(name: string): Promise<void> {
    return this.removeResource('Volume', name, () =>
      this.docker.getVolume(name).remove()
    );
  }

  async removeNetwork(id: string): Promise<void> {
    return this.removeResource('Network', id, () =>
      this.docker.getNetwork(id).remove()
    );
  }

  /** Split `repo:tag` on the last colon, since a registry may carry a port. */
  private splitRepoTag(repoTag?: string): { repository: string; tag: string } {
    if (!repoTag) return { repository: '<none>', tag: '<none>' };

    const lastColon = repoTag.lastIndexOf(':');
    // A colon before the final path separator is a registry port, not a tag.
    if (lastColon < 0 || lastColon < repoTag.lastIndexOf('/')) {
      return { repository: repoTag, tag: '<none>' };
    }
    return {
      repository: repoTag.slice(0, lastColon),
      tag: repoTag.slice(lastColon + 1)
    };
  }

  /** The 12-character form `docker images` displays. */
  private shortId(id: string): string {
    return id.replace(/^sha256:/, '').substring(0, 12);
  }

  /** Shared connected-guard and error wrapper for the list operations. */
  private async listResources<T>(label: string, fetch: () => Promise<T>): Promise<T> {
    this.ensureConnected();
    try {
      return await fetch();
    } catch (error) {
      throw this.operationError('unknown', `Failed to list ${label}`, error);
    }
  }

  /**
   * Shared guard for the remove operations, mapping daemon status codes to
   * typed errors. 403 is here because networks report "in use" that way.
   */
  private async removeResource(kind: string, id: string, remove: () => Promise<unknown>): Promise<void> {
    this.ensureConnected();
    try {
      await remove();
    } catch (error: unknown) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        throw this.operationError('resource_not_found', `${kind} ${id} not found`, error);
      }
      if (statusCode === 409 || statusCode === 403) {
        throw this.operationError('resource_in_use', `${kind} ${id} is still in use`, error);
      }
      throw this.operationError('unknown', `Failed to remove ${kind.toLowerCase()} ${id}`, error);
    }
  }

  /** Unrecognised states resolve to `unknown`, which is never removable. */
  private mapContainerStatus(state: string): ContainerStatus {
    return CONTAINER_STATUS_BY_STATE[state?.toLowerCase()] ?? 'unknown';
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Docker client is not connected. Call connect() first.');
    }
  }

  private operationError(
    type: CleanupError['type'],
    message: string,
    originalError?: unknown
  ): CleanupOperationError {
    const cleanupError = this.createError(type, message, originalError);
    return new CleanupOperationError(type, cleanupError.message, cleanupError.recoverable);
  }

  private createError(type: CleanupError['type'], message: string, originalError?: unknown): CleanupError {
    const detail = originalError instanceof Error ? originalError.message.trim() : 'Unknown error';
    return {
      type,
      message: `${message}: ${detail}`,
      timestamp: new Date(),
      recoverable: isRecoverableDockerErrorType(type)
    };
  }
}
