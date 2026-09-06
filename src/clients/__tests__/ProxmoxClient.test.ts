import { ProxmoxClient } from '../ProxmoxClient';
import { ProxmoxConfig } from '../../types';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ProxmoxClient', () => {
  let proxmoxClient: ProxmoxClient;
  let mockConfig: ProxmoxConfig;
  let mockAxiosInstance: jest.Mocked<any>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create mock config
    mockConfig = {
      host: 'proxmox.example.com',
      token: 'root@pam:password123'
    };

    // Create mock axios instance
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
      defaults: {
        headers: {
          common: {}
        }
      },
      interceptors: {
        response: {
          use: jest.fn()
        }
      }
    };

    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    proxmoxClient = new ProxmoxClient(mockConfig);
  });

  describe('Authentication', () => {
    it('should successfully authenticate with valid credentials', async () => {
      const mockAuthResponse = {
        data: {
          data: {
            ticket: 'PVE:root@pam:12345678::ticket',
            CSRFPreventionToken: 'csrf-token-123'
          }
        }
      };

      mockAxiosInstance.post.mockResolvedValue(mockAuthResponse);

      await proxmoxClient.authenticate();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/access/ticket', {
        username: 'root@pam',
        password: 'password123'
      });

      expect(proxmoxClient.isAuthenticated()).toBe(true);
      expect(mockAxiosInstance.defaults.headers.common['Cookie']).toBe('PVEAuthCookie=PVE:root@pam:12345678::ticket');
      expect(mockAxiosInstance.defaults.headers.common['CSRFPreventionToken']).toBe('csrf-token-123');
    });

    it('should fail authentication with invalid credentials', async () => {
      mockAxiosInstance.post.mockRejectedValue({
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: {
            errors: ['authentication failure']
          }
        }
      });

      await expect(proxmoxClient.authenticate()).rejects.toThrow();
      expect(proxmoxClient.isAuthenticated()).toBe(false);
    });

    it('should handle network errors during authentication', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Network Error'));

      await expect(proxmoxClient.authenticate()).rejects.toThrow();
      expect(proxmoxClient.isAuthenticated()).toBe(false);
    });

    it('should handle invalid authentication response format', async () => {
      const mockInvalidResponse = {
        data: {
          // Missing 'data' field
        }
      };

      mockAxiosInstance.post.mockResolvedValue(mockInvalidResponse);

      await expect(proxmoxClient.authenticate()).rejects.toThrow('Invalid authentication response');
      expect(proxmoxClient.isAuthenticated()).toBe(false);
    });

    it('should parse complex tokens with colons in password', async () => {
      const configWithComplexToken: ProxmoxConfig = {
        host: 'proxmox.example.com',
        token: 'root@pam:pass:word:123'
      };

      const clientWithComplexToken = new ProxmoxClient(configWithComplexToken);

      const mockAuthResponse = {
        data: {
          data: {
            ticket: 'PVE:root@pam:12345678::ticket',
            CSRFPreventionToken: 'csrf-token-123'
          }
        }
      };

      mockAxiosInstance.post.mockResolvedValue(mockAuthResponse);

      await clientWithComplexToken.authenticate();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/access/ticket', {
        username: 'root@pam',
        password: 'pass:word:123'
      });
    });

    it('should throw error for invalid token format', () => {
      const configWithInvalidToken: ProxmoxConfig = {
        host: 'proxmox.example.com',
        token: 'invalid-token-format'
      };

      expect(() => new ProxmoxClient(configWithInvalidToken)).toThrow('Invalid token format');
    });

    it('should route an API token to the PVEAPIToken header', async () => {
      const configWithApiToken: ProxmoxConfig = {
        host: 'proxmox.example.com',
        token: 'root@pam!mytoken:abc-123-secret'
      };

      const clientWithApiToken = new ProxmoxClient(configWithApiToken);

      mockAxiosInstance.get.mockResolvedValue({ data: { version: '8.0' } });

      await clientWithApiToken.authenticate();

      expect(clientWithApiToken.isAuthenticated()).toBe(true);
      expect(mockAxiosInstance.defaults.headers.common['Authorization'])
        .toBe('PVEAPIToken=root@pam!mytoken=abc-123-secret');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should route a legacy password containing "!" to /access/ticket', async () => {
      const configWithBangPassword: ProxmoxConfig = {
        host: 'proxmox.example.com',
        token: 'root@pam:p@ss!word'
      };

      const clientWithBangPassword = new ProxmoxClient(configWithBangPassword);

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            ticket: 'PVE:ticket',
            CSRFPreventionToken: 'csrf'
          }
        }
      });

      await clientWithBangPassword.authenticate();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/access/ticket', {
        username: 'root@pam',
        password: 'p@ss!word'
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle axios errors with proper error formatting', async () => {
      const axiosError = {
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: {
            errors: ['Database connection failed']
          }
        }
      };

      // Mock axios.isAxiosError to return true for our mock error
      mockedAxios.isAxiosError.mockReturnValue(true);
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(proxmoxClient.authenticate()).rejects.toThrow(
        'Failed to authenticate with Proxmox API (HTTP 500: Internal Server Error) - ["Database connection failed"]'
      );
    });

    it('should handle non-axios errors', async () => {
      const genericError = new Error('Generic error message');

      // Mock axios.isAxiosError to return false for generic errors
      mockedAxios.isAxiosError.mockReturnValue(false);
      mockAxiosInstance.post.mockRejectedValue(genericError);

      await expect(proxmoxClient.authenticate()).rejects.toThrow(
        'Failed to authenticate with Proxmox API: Generic error message'
      );
    });
  });

  describe('TLS verification', () => {
    // Proxmox ships a self-signed certificate by default, so verification is
    // opt-in — the default must stay off or every default install breaks.
    it('does not verify the certificate by default', () => {
      const call = mockedAxios.create.mock.calls[0][0] as any;
      expect(call.httpsAgent.options.rejectUnauthorized).toBe(false);
    });

    it('does not verify when verifyTls is explicitly false', () => {
      jest.clearAllMocks();
      mockedAxios.create.mockReturnValue(mockAxiosInstance);
      new ProxmoxClient({ ...mockConfig, verifyTls: false });

      const call = mockedAxios.create.mock.calls[0][0] as any;
      expect(call.httpsAgent.options.rejectUnauthorized).toBe(false);
    });

    it('verifies the certificate when verifyTls is true', () => {
      jest.clearAllMocks();
      mockedAxios.create.mockReturnValue(mockAxiosInstance);
      new ProxmoxClient({ ...mockConfig, verifyTls: true });

      const call = mockedAxios.create.mock.calls[0][0] as any;
      expect(call.httpsAgent.options.rejectUnauthorized).toBe(true);
    });
  });
});
