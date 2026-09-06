import { ProxmoxConfig, CleanupError } from '../types';
import { IProxmoxClient } from '../interfaces';
import axios, { AxiosInstance } from 'axios';
import https from 'https';

/**
 * API-token shape: user@realm!tokenid:secret
 * Requires `@realm`, then `!`, then `:` — in that order.
 * Anything else is treated as legacy user@realm:password
 * (so legacy passwords containing `!` route correctly).
 */
const API_TOKEN_PATTERN = /^[^:!]+@[^:!]+![^:]+:.+$/;

export class ProxmoxClient implements IProxmoxClient {
  private config: ProxmoxConfig;
  private apiClient!: AxiosInstance;
  private authenticated: boolean = false;
  private ticket?: string;
  private csrfToken?: string;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    this.validateToken(config.token);
    this.setupApiClient();
  }

  private validateToken(token: string): void {
    if (API_TOKEN_PATTERN.test(token)) return;
    if (token.includes('@') && token.includes(':')) return;
    throw new Error(
      'Invalid token format. Expected user@realm:password or user@realm!tokenid:secret'
    );
  }

  async authenticate(): Promise<void> {
    try {
      if (API_TOKEN_PATTERN.test(this.config.token)) {
        // API-token auth — Proxmox expects `=` between tokenid and secret
        const [tokenId, secret] = this.splitOnce(this.config.token, ':');
        this.apiClient.defaults.headers.common['Authorization'] =
          `PVEAPIToken=${tokenId}=${secret}`;

        const response = await this.apiClient.get('/version');
        if (!response.data) {
          throw new Error('Invalid API token response');
        }
        this.authenticated = true;
        return;
      }

      // Legacy user@realm:password auth
      const [username, password] = this.splitOnce(this.config.token, ':');
      const response = await this.apiClient.post('/access/ticket', {
        username,
        password
      });

      if (!response.data?.data) {
        throw new Error('Invalid authentication response');
      }

      this.ticket = response.data.data.ticket;
      this.csrfToken = response.data.data.CSRFPreventionToken;
      this.apiClient.defaults.headers.common['Cookie'] = `PVEAuthCookie=${this.ticket}`;
      this.apiClient.defaults.headers.common['CSRFPreventionToken'] = this.csrfToken;
      this.authenticated = true;
    } catch (error) {
      this.authenticated = false;
      const cleanupError = this.createError('authentication', 'Failed to authenticate with Proxmox API', error);
      throw new Error(cleanupError.message);
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private setupApiClient(): void {
    this.apiClient = axios.create({
      baseURL: `https://${this.config.host}:8006/api2/json`,
      timeout: 30000,
      httpsAgent: new https.Agent({
        // Proxmox ships a self-signed certificate by default; verification is
        // opt-in via config.proxmox.verifyTls for anyone who's replaced it.
        rejectUnauthorized: this.config.verifyTls === true
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          this.authenticated = false;
          this.ticket = undefined;
          this.csrfToken = undefined;
          delete this.apiClient.defaults.headers.common['Authorization'];
          delete this.apiClient.defaults.headers.common['Cookie'];
          delete this.apiClient.defaults.headers.common['CSRFPreventionToken'];
        }
        return Promise.reject(error);
      }
    );
  }

  private splitOnce(value: string, sep: string): [string, string] {
    const idx = value.indexOf(sep);
    if (idx < 0) return [value, ''];
    return [value.slice(0, idx), value.slice(idx + sep.length)];
  }

  private createError(type: CleanupError['type'], message: string, originalError?: unknown): CleanupError {
    let errorMessage = message;

    if (axios.isAxiosError(originalError)) {
      const status = originalError.response?.status;
      const statusText = originalError.response?.statusText;
      const responseData = originalError.response?.data;

      if (status && statusText) {
        errorMessage += ` (HTTP ${status}: ${statusText})`;
      }

      if (responseData?.errors) {
        errorMessage += ` - ${JSON.stringify(responseData.errors)}`;
      }
    } else if (originalError instanceof Error) {
      errorMessage += `: ${originalError.message}`;
    }

    return {
      type,
      message: errorMessage,
      timestamp: new Date(),
      recoverable: type === 'network' || type === 'authentication'
    };
  }
}
