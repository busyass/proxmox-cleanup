import { ResourceScanner } from '../ResourceScanner';
import { IDockerClient } from '../../interfaces';
import { ContainerResource, ContainerStatus, ImageResource, VolumeResource, NetworkResource, Resource } from '../../types';
import * as fc from 'fast-check';

// Mock Docker client for testing
class MockDockerClient implements IDockerClient {
  private containers: ContainerResource[] = [];
  private images: ImageResource[] = [];
  private volumes: VolumeResource[] = [];
  private networks: NetworkResource[] = [];
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listContainers(_all?: boolean): Promise<ContainerResource[]> {
    return this.containers;
  }

  async listImages(): Promise<ImageResource[]> {
    return this.images;
  }

  async listVolumes(): Promise<VolumeResource[]> {
    return this.volumes;
  }

  async listNetworks(): Promise<NetworkResource[]> {
    return this.networks;
  }

  async removeContainer(id: string): Promise<void> {
    const index = this.containers.findIndex(c => c.id === id);
    if (index >= 0) {
      this.containers.splice(index, 1);
    }
  }

  async removeImage(id: string): Promise<void> {
    const index = this.images.findIndex(i => i.id === id);
    if (index >= 0) {
      this.images.splice(index, 1);
    }
  }

  async removeVolume(id: string): Promise<void> {
    const index = this.volumes.findIndex(v => v.id === id);
    if (index >= 0) {
      this.volumes.splice(index, 1);
    }
  }

  async removeNetwork(id: string): Promise<void> {
    const index = this.networks.findIndex(n => n.id === id);
    if (index >= 0) {
      this.networks.splice(index, 1);
    }
  }

  // Helper methods for testing
  setContainers(containers: ContainerResource[]): void {
    this.containers = [...containers];
  }

  setImages(images: ImageResource[]): void {
    this.images = [...images];
  }

  setVolumes(volumes: VolumeResource[]): void {
    this.volumes = [...volumes];
  }

  setNetworks(networks: NetworkResource[]): void {
    this.networks = [...networks];
  }

  getContainers(): ContainerResource[] {
    return [...this.containers];
  }

  getImages(): ImageResource[] {
    return [...this.images];
  }

  getVolumes(): VolumeResource[] {
    return [...this.volumes];
  }

  getNetworks(): NetworkResource[] {
    return [...this.networks];
  }
}

// Arbitraries for generating test data
const containerArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  type: fc.constant('container' as const),
  size: fc.nat(),
  createdAt: fc.date(),
  tags: fc.array(fc.string()),
  status: fc.constantFrom<ContainerStatus>(
    'created', 'running', 'paused', 'restarting', 'exited', 'removing', 'dead'
  ),
  imageId: fc.string({ minLength: 1 }),
  volumes: fc.array(fc.string()),
  networks: fc.array(fc.string())
});

const imageArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  type: fc.constant('image' as const),
  size: fc.nat(),
  createdAt: fc.date(),
  tags: fc.array(fc.string()),
  repository: fc.string({ minLength: 1 }),
  tag: fc.string({ minLength: 1 }),
  usedByContainers: fc.array(fc.string())
});

const volumeArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  type: fc.constant('volume' as const),
  size: fc.nat(),
  createdAt: fc.date(),
  tags: fc.array(fc.string()),
  mountPoint: fc.string({ minLength: 1 }),
  usedByContainers: fc.array(fc.string())
});

const networkArbitrary = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  type: fc.constant('network' as const),
  size: fc.nat(),
  createdAt: fc.date(),
  tags: fc.array(fc.string()),
  driver: fc.string({ minLength: 1 }),
  connectedContainers: fc.array(fc.string())
});

describe('ResourceScanner - Dry Run Mode', () => {
  let mockClient: MockDockerClient;
  let scanner: ResourceScanner;

  beforeEach(async () => {
    mockClient = new MockDockerClient();
    await mockClient.connect();
    scanner = new ResourceScanner(mockClient, [], true); // Enable dry-run mode
  });

  describe('Dry Run Configuration', () => {
    it('should initialize with dry-run mode enabled', () => {
      expect(scanner.isDryRun()).toBe(true);
    });

    it('should allow toggling dry-run mode', () => {
      scanner.setDryRun(false);
      expect(scanner.isDryRun()).toBe(false);

      scanner.setDryRun(true);
      expect(scanner.isDryRun()).toBe(true);
    });
  });

  describe('Property 2: Dry Run Idempotence', () => {
    // Feature: proxmox-cleanup, Property 2: Dry Run Idempotence
    // Validates: Requirements 3.1, 3.2
    it('should produce identical results when scanning multiple times in dry-run mode', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            containers: fc.array(containerArbitrary, { maxLength: 10 }),
            images: fc.array(imageArbitrary, { maxLength: 10 }),
            volumes: fc.array(volumeArbitrary, { maxLength: 10 }),
            networks: fc.array(networkArbitrary, { maxLength: 10 })
          }),
          async (testData) => {
            // Setup test data
            mockClient.setContainers(testData.containers);
            mockClient.setImages(testData.images);
            mockClient.setVolumes(testData.volumes);
            mockClient.setNetworks(testData.networks);

            // Ensure scanner is in dry-run mode
            scanner.setDryRun(true);

            // Perform first scan
            const firstScanContainers = await scanner.scanContainers();
            const firstScanImages = await scanner.scanImages();
            const firstScanVolumes = await scanner.scanVolumes();
            const firstScanNetworks = await scanner.scanNetworks();

            // Perform second scan
            const secondScanContainers = await scanner.scanContainers();
            const secondScanImages = await scanner.scanImages();
            const secondScanVolumes = await scanner.scanVolumes();
            const secondScanNetworks = await scanner.scanNetworks();

            // Property: Results should be identical
            expect(firstScanContainers).toEqual(secondScanContainers);
            expect(firstScanImages).toEqual(secondScanImages);
            expect(firstScanVolumes).toEqual(secondScanVolumes);
            expect(firstScanNetworks).toEqual(secondScanNetworks);

            // Property: Original data should remain unchanged
            expect(mockClient.getContainers()).toEqual(testData.containers);
            expect(mockClient.getImages()).toEqual(testData.images);
            expect(mockClient.getVolumes()).toEqual(testData.volumes);
            expect(mockClient.getNetworks()).toEqual(testData.networks);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should not modify any resources during dry-run cleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            containers: fc.array(containerArbitrary, { maxLength: 5 }),
            images: fc.array(imageArbitrary, { maxLength: 5 }),
            volumes: fc.array(volumeArbitrary, { maxLength: 5 }),
            networks: fc.array(networkArbitrary, { maxLength: 5 })
          }),
          async (testData) => {
            // Setup test data
            mockClient.setContainers(testData.containers);
            mockClient.setImages(testData.images);
            mockClient.setVolumes(testData.volumes);
            mockClient.setNetworks(testData.networks);

            // Store original state
            const originalContainers = mockClient.getContainers();
            const originalImages = mockClient.getImages();
            const originalVolumes = mockClient.getVolumes();
            const originalNetworks = mockClient.getNetworks();

            // Ensure scanner is in dry-run mode
            scanner.setDryRun(true);

            // Scan for unused resources
            const unusedContainers = await scanner.scanContainers();
            const unusedImages = await scanner.scanImages();
            const unusedVolumes = await scanner.scanVolumes();
            const unusedNetworks = await scanner.scanNetworks();

            // Combine all unused resources
            const allUnusedResources: Resource[] = [
              ...unusedContainers,
              ...unusedImages,
              ...unusedVolumes,
              ...unusedNetworks
            ];

            // Perform dry-run cleanup
            const result = await scanner.performCleanup(allUnusedResources);

            // Property: No resources should be actually removed in dry-run mode
            expect(mockClient.getContainers()).toEqual(originalContainers);
            expect(mockClient.getImages()).toEqual(originalImages);
            expect(mockClient.getVolumes()).toEqual(originalVolumes);
            expect(mockClient.getNetworks()).toEqual(originalNetworks);

            // Property: Dry-run should report what would be removed
            expect(result.removed.length).toBeGreaterThanOrEqual(0);
            expect(result.skipped.length).toBeGreaterThanOrEqual(0);
            expect(result.errors.length).toBe(0); // No errors in dry-run mode
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should produce consistent results across multiple dry-run cleanup operations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            containerCount: fc.integer({ min: 0, max: 3 }),
            imageCount: fc.integer({ min: 0, max: 3 }),
            volumeCount: fc.integer({ min: 0, max: 3 }),
            networkCount: fc.integer({ min: 0, max: 3 })
          }),
          async (testData) => {
            // Create unused resources directly
            const containers: ContainerResource[] = Array.from({ length: testData.containerCount }, (_, i) => ({
              id: `container${i}`,
              name: `stopped-container-${i}`,
              type: 'container' as const,
              size: 1000,
              createdAt: new Date(),
              tags: [],
              status: 'exited' as const,
              imageId: `image${i}`,
              volumes: [],
              networks: []
            }));

            const images: ImageResource[] = Array.from({ length: testData.imageCount }, (_, i) => ({
              id: `image${i}`,
              name: `unused-image-${i}`,
              type: 'image' as const,
              size: 5000,
              createdAt: new Date(),
              tags: [],
              repository: `repo${i}`,
              tag: 'latest',
              usedByContainers: []
            }));

            const volumes: VolumeResource[] = Array.from({ length: testData.volumeCount }, (_, i) => ({
              id: `volume${i}`,
              name: `unused-volume-${i}`,
              type: 'volume' as const,
              size: 2000,
              createdAt: new Date(),
              tags: [],
              mountPoint: `/data/volume${i}`,
              usedByContainers: []
            }));

            const networks: NetworkResource[] = Array.from({ length: testData.networkCount }, (_, i) => ({
              id: `network${i}`,
              name: `unused-network-${i}`,
              type: 'network' as const,
              size: 0,
              createdAt: new Date(),
              tags: [],
              driver: 'bridge',
              connectedContainers: []
            }));

            // Setup test data with unused resources
            mockClient.setContainers(containers);
            mockClient.setImages(images);
            mockClient.setVolumes(volumes);
            mockClient.setNetworks(networks);

            // Ensure scanner is in dry-run mode
            scanner.setDryRun(true);

            // Get unused resources
            const unusedResources: Resource[] = [
              ...await scanner.scanContainers(),
              ...await scanner.scanImages(),
              ...await scanner.scanVolumes(),
              ...await scanner.scanNetworks()
            ];

            // Perform first dry-run cleanup
            const firstResult = await scanner.performCleanup(unusedResources);

            // Perform second dry-run cleanup
            const secondResult = await scanner.performCleanup(unusedResources);

            // Property: Results should be identical
            expect(firstResult.removed).toEqual(secondResult.removed);
            expect(firstResult.skipped).toEqual(secondResult.skipped);
            expect(firstResult.errors).toEqual(secondResult.errors);

            // Property: Both operations should report the same resources as removable
            expect(firstResult.removed.length).toBe(secondResult.removed.length);
            expect(firstResult.skipped.length).toBe(secondResult.skipped.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Dry Run vs Actual Cleanup Comparison', () => {
    it('should show difference between dry-run and actual cleanup', async () => {
      // Create test data with unused resources
      const testContainers: ContainerResource[] = [
        {
          id: 'container1',
          name: 'stopped-container',
          type: 'container',
          size: 1000,
          createdAt: new Date(),
          tags: [],
          status: 'exited',
          imageId: 'image1',
          volumes: [],
          networks: []
        }
      ];

      mockClient.setContainers(testContainers);

      // Test dry-run mode
      scanner.setDryRun(true);
      const unusedContainers = await scanner.scanContainers();
      const dryRunResult = await scanner.performCleanup(unusedContainers);

      // Verify resources still exist after dry-run
      expect(mockClient.getContainers()).toHaveLength(1);
      expect(dryRunResult.removed).toHaveLength(1);

      // Test actual cleanup mode
      scanner.setDryRun(false);
      const actualResult = await scanner.performCleanup(unusedContainers);

      // Verify resources are actually removed
      expect(mockClient.getContainers()).toHaveLength(0);
      expect(actualResult.removed).toHaveLength(1);
    });
  });
});
