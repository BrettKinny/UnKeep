export interface RelaySession {
  endpoint: string;
  instanceId: string;
  deviceId: string;
  credential: string;
}

export interface RelayStatus { protocol: number; instanceId: string; initialized: boolean }
export interface DeviceCredential { id:string; name:string; revokedAt:string|null }
export interface ServiceCredential { id:string; name:string; createdAt:string; revokedAt:string|null }
export interface RelayChange { kind:'note'|'attachment'; id:string; noteId?:string; envelope:unknown; deleted:boolean; revision:number }

export interface RelayClientOptions {
  allowInsecure?: boolean;
}

function isSafeHttpHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;

  const octets = hostname.split('.');
  if (octets.length === 4 && octets.every(octet => /^\d+$/.test(octet))) {
    const [first, second] = octets.map(Number);
    if (first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return true;
  }

  return hostname.endsWith('.internal') || (!hostname.includes('.') && !hostname.includes(':'));
}

export function cleanRelayEndpoint(value: string, options: RelayClientOptions = {}): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The sync server endpoint must use HTTP or HTTPS');
  }
  if (url.protocol === 'http:' && !options.allowInsecure && !isSafeHttpHostname(url.hostname)) {
    throw new Error(`Plain HTTP is not allowed for ${url.hostname}. Use HTTPS, or set allowInsecure: true when constructing RelayClient to override this protection.`);
  }
  return url.origin;
}

export class RelayClient {
  readonly endpoint: string;
  private readonly credential?: string;

  constructor(endpoint: string, options?: RelayClientOptions);
  constructor(endpoint: string, credential?: string, options?: RelayClientOptions);
  constructor(endpoint: string, credentialOrOptions?: string | RelayClientOptions, options: RelayClientOptions = {}) {
    this.credential = typeof credentialOrOptions === 'string' ? credentialOrOptions : undefined;
    this.endpoint = cleanRelayEndpoint(endpoint, typeof credentialOrOptions === 'object' ? credentialOrOptions : options);
  }

  private async request<T>(path: string, init: RequestInit = {}, authorization?: string): Promise<T> {
    const response = await globalThis.fetch(`${this.endpoint}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(this.credential ? { authorization: `Device ${this.credential}` } : {}), ...(authorization ? { authorization } : {}), ...init.headers }
    });
    const value = response.status === 204 ? {} : await response.json() as { error?: string };
    if (!response.ok) throw new Error(value.error || `Sync server returned ${response.status}`);
    return value as T;
  }

  status() { return this.request<RelayStatus>('/status'); }
  claimSetup(setupToken: string, deviceId: string, name: string) {
    return this.request<{instanceId:string;deviceCredential:string}>('/setup/claim', { method:'POST', body:JSON.stringify({deviceId,name}) }, `Setup ${setupToken}`);
  }
  vault() { return this.request<{vaultId:string}>('/vault'); }
  devices() { return this.request<{devices:DeviceCredential[]}>('/devices'); }
  serviceCredentials() { return this.request<{serviceCredentials:ServiceCredential[]}>('/service-credentials'); }
  mintServiceCredential(name:string) { return this.request<{id:string;name:string;createdAt:string;serviceCredential:string}>('/service-credentials',{method:'POST',body:JSON.stringify({name})}); }
  revokeServiceCredential(id:string) { return this.request(`/service-credentials/${encodeURIComponent(id)}`,{method:'DELETE'}); }
  changes(since: number) { return this.request<{changes:RelayChange[];cursor:number}>(`/changes?since=${since}`); }
  putNote(id:string, value:unknown) { return this.request<{revision:number}>(`/notes/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  putAttachment(id:string, value:unknown) { return this.request<{revision:number}>(`/attachments/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  getAttachment(id:string) { return this.request<{noteId:string;envelope:unknown;deleted:boolean;revision:number}>(`/attachments/${encodeURIComponent(id)}`); }
  createPairing(value:unknown) { return this.request<{requestId:string;code:string;pollSecret:string;expiresAt:string}>('/pairings',{method:'POST',body:JSON.stringify(value)}); }
  pollPairing(id:string, secret:string) { return this.request<{response:unknown;deviceCredential:string|null;consumed:boolean}>(`/pairings/${id}?secret=${encodeURIComponent(secret)}`); }
  pairingByCode(code:string) { return this.request<{id:string;deviceId:string;deviceName:string;publicKey:JsonWebKey;expiresAt:string}>(`/pairings/code/${encodeURIComponent(code)}`); }
  approvePairing(id:string,response:unknown) { return this.request(`/pairings/${id}/approve`,{method:'POST',body:JSON.stringify({response})}); }
  consumePairing(id:string) { return this.request(`/pairings/${id}/consume`,{method:'POST',body:'{}'}); }
}
