import { DockerClient } from '../DockerClient';
import Docker from 'dockerode';

// Mock dockerode
jest.mock('dockerode');

describe('DockerClient', () => {
  let dockerClient: DockerClient;
  let mockDocker: jest.Mocked<Docker>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create mock Docker instance
    mockDocker = {
      ping: jest.fn(),
      listContainers: jest.fn(),
      listImages: jest.fn(),
      listVolumes: jest.fn(),
      listNetworks: jest.fn(),
      getContainer: jest.fn(),
      getImage: jest.fn(),
      getVolume: jest.fn(),
      getNetwork: jest.fn()
    } as any;

    // Mock Docker constructor
    (Docker as jest.MockedClass<typeof Docker>).mockImplementation(() => mockDocker);

    dockerClient = new DockerClient();
  });

  describe('Connection', () => {
    it('should successfully connect to Docker daemon', async () => {
      mockDocker.ping.mockResolvedValue({} as any);

      await dockerClient.connect();

      expect(mockDocker.ping).toHaveBeenCalled();
      expect(dockerClient.isConnected()).toBe(true);
    });

    it('should fail to connect when Docker daemon is not available', async () => {
      mockDocker.ping.mockRejectedValue(new Error('Connection refused'));

      await expect(dockerClient.connect()).rejects.toThrow();
      expect(dockerClient.isConnected()).toBe(false);
    });

    it('should throw error when operations are called without connection', async () => {
      await expect(dockerClient.listContainers()).rejects.toThrow(
        'Docker client is not connected'
      );
    });
  });

  describe('List Operations', () => {
    beforeEach(async () => {
      mockDocker.ping.mockResolvedValue({} as any);
      await dockerClient.connect();
    });

    it('should list containers successfully', async () => {
      const mockContainers = [
        {
          Id: 'container1',
          Names: ['/test-container'],
          State: 'running',
          Created: Math.floor(Date.now() / 1000),
          ImageID: 'image1',
          Labels: { app: 'test' },
          Mounts: [{ Name: 'volume1', Source: '/data' }]
        }
      ];

      mockDocker.listContainers.mockResolvedValue(mockContainers as any);

      const result = await dockerClient.listContainers(true);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-container');
      expect(result[0].status).toBe('running');
      expect(result[0].type).toBe('container');
    });

    it('should list images successfully', async () => {
      const mockImages = [
        {
          Id: 'image1',
          RepoTags: ['nginx:latest'],
          Size: 1000000,
          Created: Math.floor(Date.now() / 1000),
          Labels: {}
        }
      ];

      mockDocker.listImages.mockResolvedValue(mockImages as any);

      const result = await dockerClient.listImages();

      expect(result).toHaveLength(1);
      expect(result[0].repository).toBe('nginx');
      expect(result[0].tag).toBe('latest');
      expect(result[0].type).toBe('image');
    });

    it('should list volumes successfully', async () => {
      const mockVolumes = {
        Volumes: [
          {
            Name: 'test-volume',
            Mountpoint: '/var/lib/docker/volumes/test-volume',
            Labels: {}
          }
        ]
      };

      mockDocker.listVolumes.mockResolvedValue(mockVolumes as any);

      const result = await dockerClient.listVolumes();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-volume');
      expect(result[0].type).toBe('volume');
    });

    it('should list networks successfully', async () => {
      const mockNetworks = [
        {
          Id: 'network1',
          Name: 'bridge',
          Driver: 'bridge',
          Created: new Date().toISOString(),
          Labels: {}
        }
      ];

      mockDocker.listNetworks.mockResolvedValue(mockNetworks as any);

      const result = await dockerClient.listNetworks();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('bridge');
      expect(result[0].driver).toBe('bridge');
      expect(result[0].type).toBe('network');
    });

    it('leaves createdAt undefined for volumes when the Engine reports no creation time', async () => {
      mockDocker.listVolumes.mockResolvedValue({
        Volumes: [{ Name: 'vol1', Mountpoint: '/var/lib/docker/volumes/vol1', Labels: {} }]
      } as any);

      const result = await dockerClient.listVolumes();

      expect(result).toHaveLength(1);
      expect(result[0].createdAt).toBeUndefined();
    });

    it('populates createdAt for networks when the Engine reports Created', async () => {
      const created = '2020-01-01T00:00:00.000Z';
      mockDocker.listNetworks.mockResolvedValue([
        { Id: 'net1', Name: 'mynet', Created: created, Driver: 'bridge', Labels: {} }
      ] as any);

      const result = await dockerClient.listNetworks();

      expect(result[0].createdAt).toEqual(new Date(created));
    });

    it('leaves createdAt undefined for networks when Created is absent', async () => {
      mockDocker.listNetworks.mockResolvedValue([
        { Id: 'net2', Name: 'mynet2', Driver: 'bridge', Labels: {} }
      ] as any);

      const result = await dockerClient.listNetworks();

      expect(result[0].createdAt).toBeUndefined();
    });

    // Engine contract C5: SizeRw is only populated when size=1 is requested.
    // Without this assertion a refactor can silently drop the flag and every
    // container reports 0 B again.
    it('requests container sizes, or every container would report 0 B', async () => {
      mockDocker.listContainers.mockResolvedValue([] as any);

      await dockerClient.listContainers(true);

      expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true, size: true });
    });

    // Engine contract C9: `all: true` would add intermediate layers, which
    // always have descendants and so can never be removed.
    it('does not ask for intermediate image layers', async () => {
      mockDocker.listImages.mockResolvedValue([] as any);

      await dockerClient.listImages();

      expect(mockDocker.listImages).toHaveBeenCalledWith();
    });

    // Engine contract C1: the State enum has seven values, not three.
    it('maps every Engine container state to a distinct status', async () => {
      const states = ['created', 'running', 'paused', 'restarting', 'exited', 'removing', 'dead'];
      mockDocker.listContainers.mockResolvedValue(states.map((State, i) => ({
        Id: `c${i}`, Names: [`/${State}-svc`], State,
        Created: Math.floor(Date.now() / 1000), ImageID: 'i1', Labels: {}, Mounts: []
      })) as any);

      const result = await dockerClient.listContainers(true);

      expect(result.map(c => c.status)).toEqual(states);
    });

    it('maps an unrecognised container state to unknown', async () => {
      mockDocker.listContainers.mockResolvedValue([{
        Id: 'c1', Names: ['/future-svc'], State: 'hibernated',
        Created: Math.floor(Date.now() / 1000), ImageID: 'i1', Labels: {}, Mounts: []
      }] as any);

      const result = await dockerClient.listContainers(true);

      expect(result[0].status).toBe('unknown');
    });

    // Engine contract C2: attachment must come from the container side.
    it('reads network attachment from the container, since the network list omits it', async () => {
      mockDocker.listContainers.mockResolvedValue([{
        Id: 'c1', Names: ['/web'], State: 'running',
        Created: Math.floor(Date.now() / 1000), ImageID: 'i1', Labels: {}, Mounts: [],
        NetworkSettings: { Networks: { myapp_default: {}, bridge: {} } }
      }] as any);

      const result = await dockerClient.listContainers(true);

      expect(result[0].networks.sort()).toEqual(['bridge', 'myapp_default']);
    });

    it('tolerates a container with no NetworkSettings', async () => {
      mockDocker.listContainers.mockResolvedValue([{
        Id: 'c1', Names: ['/web'], State: 'exited',
        Created: Math.floor(Date.now() / 1000), ImageID: 'i1', Labels: {}, Mounts: []
      }] as any);

      const result = await dockerClient.listContainers(true);

      expect(result[0].networks).toEqual([]);
    });

    it('splits a registry-with-port image reference on the tag, not the port', async () => {
      mockDocker.listImages.mockResolvedValue([{
        Id: 'sha256:abc', RepoTags: ['registry.example.com:5000/team/svc:1.2.3'],
        Size: 1, Created: Math.floor(Date.now() / 1000), Labels: {}
      }] as any);

      const result = await dockerClient.listImages();

      expect(result[0].repository).toBe('registry.example.com:5000/team/svc');
      expect(result[0].tag).toBe('1.2.3');
    });

    it('exposes labels as both key and key=value so tag: patterns can match either', async () => {
      mockDocker.listContainers.mockResolvedValue([{
        Id: 'c1', Names: ['/web'], State: 'exited',
        Created: Math.floor(Date.now() / 1000), ImageID: 'i1', Mounts: [],
        Labels: { env: 'production', backup: '' }
      }] as any);

      const result = await dockerClient.listContainers(true);

      expect(result[0].tags).toContain('env');
      // Keeping only the keys meant `-p tag:env=production` silently matched
      // nothing and the resource the user meant to keep was removed.
      expect(result[0].tags).toContain('env=production');
      // A valueless label yields just the key, not a trailing "=".
      expect(result[0].tags).toContain('backup');
      expect(result[0].tags).not.toContain('backup=');
    });

    it('names an untagged image with a short id so a list of them is reviewable', async () => {
      mockDocker.listImages.mockResolvedValue([{
        Id: 'sha256:ec3f0931a6e6b6855d76b2d7b0be30e81860baccd891b2e243280bf1cd8ad710',
        RepoTags: [], Size: 1, Created: Math.floor(Date.now() / 1000), Labels: {}
      }] as any);

      const result = await dockerClient.listImages();

      expect(result[0].name).toBe('<none>:<none> (ec3f0931a6e6)');
    });
  });

  describe('Remove Operations', () => {
    beforeEach(async () => {
      mockDocker.ping.mockResolvedValue({} as any);
      await dockerClient.connect();
    });

    it('should remove container successfully', async () => {
      const mockContainer = {
        remove: jest.fn().mockResolvedValue({})
      };
      mockDocker.getContainer.mockReturnValue(mockContainer as any);

      await dockerClient.removeContainer('container1');

      expect(mockDocker.getContainer).toHaveBeenCalledWith('container1');
      // Deliberately NOT { force: true }. The Engine documents force as "if the
      // container is running, kill it before removing it", which turned its 409
      // safety refusal into a kill. The scan only ever hands us dormant
      // containers, so force is unnecessary and 409 stays a real backstop.
      expect(mockContainer.remove).toHaveBeenCalledWith();
    });

    it('should handle container not found error', async () => {
      const mockContainer = {
        remove: jest.fn().mockRejectedValue({ statusCode: 404 })
      };
      mockDocker.getContainer.mockReturnValue(mockContainer as any);

      await expect(dockerClient.removeContainer('nonexistent')).rejects.toThrow();
    });

    it('should remove image successfully', async () => {
      const mockImage = {
        remove: jest.fn().mockResolvedValue({})
      };
      mockDocker.getImage.mockReturnValue(mockImage as any);

      await dockerClient.removeImage('image1');

      expect(mockDocker.getImage).toHaveBeenCalledWith('image1');
      expect(mockImage.remove).toHaveBeenCalledWith({ force: true });
    });

    it('should handle image in use error', async () => {
      const mockImage = {
        remove: jest.fn().mockRejectedValue({ statusCode: 409 })
      };
      mockDocker.getImage.mockReturnValue(mockImage as any);

      await expect(dockerClient.removeImage('image1')).rejects.toThrow();
    });

    it('should remove volume successfully', async () => {
      const mockVolume = {
        remove: jest.fn().mockResolvedValue({})
      };
      mockDocker.getVolume.mockReturnValue(mockVolume as any);

      await dockerClient.removeVolume('volume1');

      expect(mockDocker.getVolume).toHaveBeenCalledWith('volume1');
      expect(mockVolume.remove).toHaveBeenCalled();
    });

    it('should remove network successfully', async () => {
      const mockNetwork = {
        remove: jest.fn().mockResolvedValue({})
      };
      mockDocker.getNetwork.mockReturnValue(mockNetwork as any);

      await dockerClient.removeNetwork('network1');

      expect(mockDocker.getNetwork).toHaveBeenCalledWith('network1');
      expect(mockNetwork.remove).toHaveBeenCalled();
    });

    // Engine contract C3: networks alone report "in use" as 403, not 409.
    // Unmapped, this surfaced to the user as the daemon's word "unexpected".
    it('classifies a network 403 as still-in-use, not as an unexpected failure', async () => {
      const mockNetwork = {
        remove: jest.fn().mockRejectedValue({
          statusCode: 403,
          message: '(HTTP code 403) unexpected - network myapp_default has active endpoints '
        })
      };
      mockDocker.getNetwork.mockReturnValue(mockNetwork as any);

      await expect(dockerClient.removeNetwork('network1'))
        .rejects.toThrow(/is still in use/);
    });

    it('carries the classified error type to the caller', async () => {
      const mockVolume = {
        remove: jest.fn().mockRejectedValue({ statusCode: 409 })
      };
      mockDocker.getVolume.mockReturnValue(mockVolume as any);

      await expect(dockerClient.removeVolume('vol1'))
        .rejects.toMatchObject({ type: 'resource_in_use' });
    });

    it('classifies a 404 as not-found and recoverable', async () => {
      const mockImage = {
        remove: jest.fn().mockRejectedValue({ statusCode: 404 })
      };
      mockDocker.getImage.mockReturnValue(mockImage as any);

      await expect(dockerClient.removeImage('gone'))
        .rejects.toMatchObject({ type: 'resource_not_found', recoverable: true });
    });
  });

  // Feature: proxmox-cleanup, Property 7: Removal Atomicity
  // Validates: Requirements 2.5
  describe('Removal Atomicity', () => {
    beforeEach(async () => {
      mockDocker.ping.mockResolvedValue({} as any);
      await dockerClient.connect();
    });

    it('should continue removing other resources when one removal fails', async () => {
      const mockContainer1 = {
        remove: jest.fn().mockResolvedValue({})
      };
      const mockContainer2 = {
        remove: jest.fn().mockRejectedValue(new Error('Removal failed'))
      };
      const mockContainer3 = {
        remove: jest.fn().mockResolvedValue({})
      };

      mockDocker.getContainer
        .mockReturnValueOnce(mockContainer1 as any)
        .mockReturnValueOnce(mockContainer2 as any)
        .mockReturnValueOnce(mockContainer3 as any);

      // Try to remove three containers, second one fails
      const results = await Promise.allSettled([
        dockerClient.removeContainer('container1'),
        dockerClient.removeContainer('container2'),
        dockerClient.removeContainer('container3')
      ]);

      // Property: First and third removals should succeed
      expect(results[0].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');

      // Property: Second removal should fail but not affect others
      expect(results[1].status).toBe('rejected');

      // Property: All removal attempts should be made
      expect(mockContainer1.remove).toHaveBeenCalled();
      expect(mockContainer2.remove).toHaveBeenCalled();
      expect(mockContainer3.remove).toHaveBeenCalled();
    });

    it('should handle mixed success and failure scenarios', async () => {
      const mockImage1 = {
        remove: jest.fn().mockResolvedValue({})
      };
      const mockImage2 = {
        remove: jest.fn().mockRejectedValue({ statusCode: 409 }) // In use
      };
      const mockImage3 = {
        remove: jest.fn().mockRejectedValue({ statusCode: 404 }) // Not found
      };

      mockDocker.getImage
        .mockReturnValueOnce(mockImage1 as any)
        .mockReturnValueOnce(mockImage2 as any)
        .mockReturnValueOnce(mockImage3 as any);

      const results = await Promise.allSettled([
        dockerClient.removeImage('image1'),
        dockerClient.removeImage('image2'),
        dockerClient.removeImage('image3')
      ]);

      // Property: Each removal should be attempted independently
      expect(mockImage1.remove).toHaveBeenCalled();
      expect(mockImage2.remove).toHaveBeenCalled();
      expect(mockImage3.remove).toHaveBeenCalled();

      // Property: Success should not be affected by failures
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('rejected');
    });
  });
});
