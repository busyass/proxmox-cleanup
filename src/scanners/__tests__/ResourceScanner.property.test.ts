import * as fc from 'fast-check';
import { ResourceScanner } from '../ResourceScanner';
import { IDockerClient } from '../../interfaces';
import { ContainerStatus } from '../../types';

// Feature: proxmox-cleanup
// Property: Resource identification completeness
// Validates: Requirements 1.1, 1.2, 1.3, 1.4

/**
 * The Docker Engine's full `State` enum for `GET /containers/json`, verified
 * against the v1.51 API spec. Tests generate over ALL of these, not just the
 * three the tool used to recognise — `paused` and `restarting` are live
 * containers and were previously classified as removable.
 */
const ENGINE_CONTAINER_STATES: ContainerStatus[] = [
  'created', 'running', 'paused', 'restarting', 'exited', 'removing', 'dead'
];

/** The only states a cleanup may act on. */
const REMOVABLE: ContainerStatus[] = ['exited', 'created', 'dead'];

const containerArbitrary = fc.record({
  id: fc.hexaString({ minLength: 12, maxLength: 64 }),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  status: fc.constantFrom(...ENGINE_CONTAINER_STATES),
  imageId: fc.hexaString({ minLength: 12, maxLength: 64 }),
  size: fc.nat(),
  createdAt: fc.date(),
  tags: fc.array(fc.string(), { maxLength: 5 }),
  volumes: fc.array(fc.string(), { maxLength: 3 }),
  networks: fc.array(fc.string(), { maxLength: 3 })
});

function mockClient(overrides: Partial<IDockerClient> = {}): IDockerClient {
  return {
    connect: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    listContainers: jest.fn().mockResolvedValue([]),
    listImages: jest.fn().mockResolvedValue([]),
    listVolumes: jest.fn().mockResolvedValue([]),
    listNetworks: jest.fn().mockResolvedValue([]),
    removeContainer: jest.fn(),
    removeImage: jest.fn(),
    removeVolume: jest.fn(),
    removeNetwork: jest.fn(),
    ...overrides
  };
}

describe('ResourceScanner Property Tests', () => {
  it('classifies exactly the dormant container states as unused, over the full Engine enum', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(containerArbitrary, { minLength: 0, maxLength: 20 }),
        async (containers) => {
          const scanner = new ResourceScanner(mockClient({
            listContainers: jest.fn().mockResolvedValue(
              containers.map(c => ({ ...c, type: 'container' as const }))
            )
          }));

          const unused = await scanner.scanContainers();

          const expected = containers.filter(c => REMOVABLE.includes(c.status));
          expect(unused.map(c => c.id).sort()).toEqual(expected.map(c => c.id).sort());
          // The whole point of the allow-list: no live or transitional state
          // may ever reach the removal set.
          expect(unused.every(c => REMOVABLE.includes(c.status))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never classifies a live or transitional container as unused', async () => {
    // Explicit non-property companion: each live state, named, so a regression
    // reports WHICH state leaked rather than a shrunk counterexample.
    for (const status of ['running', 'paused', 'restarting', 'removing', 'unknown'] as ContainerStatus[]) {
      const scanner = new ResourceScanner(mockClient({
        listContainers: jest.fn().mockResolvedValue([{
          id: 'c1', name: `${status}-svc`, type: 'container' as const, status,
          size: 0, createdAt: new Date(), tags: [], imageId: 'i1',
          volumes: [], networks: []
        }])
      }));

      const unused = await scanner.scanContainers();
      expect(unused).toHaveLength(0);
    }
  });

  it('treats an unrecognised container state as not removable (fails safe)', async () => {
    const scanner = new ResourceScanner(mockClient({
      listContainers: jest.fn().mockResolvedValue([{
        id: 'c1', name: 'future-svc', type: 'container' as const,
        // A state a future Engine might add, which this version doesn't know.
        status: 'hibernated' as ContainerStatus,
        size: 0, createdAt: new Date(), tags: [], imageId: 'i1',
        volumes: [], networks: []
      }])
    }));

    expect(await scanner.scanContainers()).toHaveLength(0);
  });
});


// Feature: proxmox-cleanup, Property 1: Safe Removal Guarantee
// Validates: Requirements 2.1, 2.2, 2.3
it('should not mark resources as unused if they are in use by any container', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(
        fc.array(containerArbitrary, { minLength: 1, maxLength: 10 }),
        // Generate images
        fc.array(
          fc.record({
            id: fc.hexaString({ minLength: 12, maxLength: 64 }),
            repository: fc.string({ minLength: 1, maxLength: 20 }),
            tag: fc.string({ minLength: 1, maxLength: 10 }),
            size: fc.nat(),
            createdAt: fc.date(),
            tags: fc.array(fc.string(), { maxLength: 5 })
          }),
          { minLength: 1, maxLength: 10 }
        )
      ),
      async ([containers, images]) => {
        const scanner = new ResourceScanner(mockClient({
          listContainers: jest.fn().mockResolvedValue(
            containers.map(c => ({ ...c, type: 'container' as const }))
          ),
          listImages: jest.fn().mockResolvedValue(
            images.map(img => ({
              ...img,
              name: `${img.repository}:${img.tag}`,
              type: 'image' as const,
              usedByContainers: []
            }))
          )
        }));

        // Scan for unused images
        const unusedImages = await scanner.scanImages();

        // Build set of image IDs used by containers
        const usedImageIds = new Set(containers.map(c => c.imageId));

        // Property: No unused image should be used by any container
        const allSafe = unusedImages.every(img => !usedImageIds.has(img.id));

        // Property: All images used by containers should NOT be in unused list
        const noUsedImagesInResult = unusedImages.every(img => {
          return !containers.some(c => c.imageId === img.id);
        });

        expect(allSafe).toBe(true);
        expect(noUsedImagesInResult).toBe(true);
      }
    ),
    { numRuns: 100 }
  );
});

// Feature: proxmox-cleanup — network attachment is derived container-side,
// because GET /networks stopped reporting it in API 1.28 (contract C2).
describe('ResourceScanner network attachment', () => {
  it('protects a network any container is attached to, and lists the rest', async () => {
    const containers = [
      {
        id: 'web1', name: 'web', type: 'container' as const, status: 'running' as ContainerStatus,
        size: 0, createdAt: new Date(), tags: [], imageId: 'i1',
        volumes: [], networks: ['myapp_default', 'bridge']
      },
      {
        id: 'old1', name: 'old', type: 'container' as const, status: 'exited' as ContainerStatus,
        size: 0, createdAt: new Date(), tags: [], imageId: 'i2',
        volumes: [], networks: ['legacy_net']
      }
    ];
    // Note: no `Containers` key — the real list endpoint does not send one.
    const networks = ['myapp_default', 'legacy_net', 'orphan_net', 'bridge', 'host', 'none']
      .map(name => ({
        id: `${name}-id`, name, type: 'network' as const, size: 0,
        createdAt: new Date(), tags: [], driver: 'bridge', connectedContainers: []
      }));

    const scanner = new ResourceScanner(mockClient({
      listContainers: jest.fn().mockResolvedValue(containers),
      listNetworks: jest.fn().mockResolvedValue(networks)
    }));

    const unused = await scanner.scanNetworks();

    expect(unused.map(n => n.name)).toEqual(['orphan_net']);
    // Attached-to-a-running-container: the bug this fixes.
    expect(unused.some(n => n.name === 'myapp_default')).toBe(false);
    // Attached only to an exited container: still kept. That container is
    // itself a candidate, so the network frees on the next run.
    expect(unused.some(n => n.name === 'legacy_net')).toBe(false);
    // Docker's built-ins are never candidates.
    expect(unused.some(n => ['bridge', 'host', 'none'].includes(n.name))).toBe(false);
  });

  it('reports a kept network as in use via isResourceInUse', async () => {
    const containers = [{
      id: 'web1', name: 'web', type: 'container' as const, status: 'running' as ContainerStatus,
      size: 0, createdAt: new Date(), tags: [], imageId: 'i1',
      volumes: [], networks: ['myapp_default']
    }];
    const scanner = new ResourceScanner(mockClient({
      listContainers: jest.fn().mockResolvedValue(containers)
    }));

    const network = {
      id: 'n1', name: 'myapp_default', type: 'network' as const, size: 0,
      createdAt: new Date(), tags: [], driver: 'bridge', connectedContainers: []
    };

    expect(await scanner.isResourceInUse(network, containers)).toBe(true);
  });
});

// Feature: proxmox-cleanup — the cleanup-time re-check must read the FRESH
// container list, not the status captured during the scan. Otherwise it can
// never disagree with the scan and protects nothing.
describe('ResourceScanner cleanup-time re-check', () => {
  it('skips a container that started between scan and cleanup', async () => {
    const scanned = {
      id: 'c1', name: 'worker', type: 'container' as const,
      status: 'exited' as ContainerStatus, size: 0, createdAt: new Date(),
      tags: [], imageId: 'i1', volumes: [], networks: []
    };
    // By cleanup time the same container is running again.
    const fresh = [{ ...scanned, status: 'running' as ContainerStatus }];

    const removeContainer = jest.fn();
    const scanner = new ResourceScanner(mockClient({
      listContainers: jest.fn().mockResolvedValue(fresh),
      removeContainer
    }));

    const result = await scanner.performCleanup([scanned]);

    expect(result.removed).toHaveLength(0);
    expect(result.skipped.map(r => r.id)).toEqual(['c1']);
    expect(removeContainer).not.toHaveBeenCalled();
    expect(result.skipReasons.get('c1')).toContain('running');
  });

  it('explains a paused container in the skip reason', async () => {
    const scanned = {
      id: 'c2', name: 'paused-svc', type: 'container' as const,
      status: 'exited' as ContainerStatus, size: 0, createdAt: new Date(),
      tags: [], imageId: 'i1', volumes: [], networks: []
    };
    const scanner = new ResourceScanner(mockClient({
      listContainers: jest.fn().mockResolvedValue([
        { ...scanned, status: 'paused' as ContainerStatus }
      ])
    }));

    const result = await scanner.performCleanup([scanned]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipReasons.get('c2')).toContain('paused');
  });
});
