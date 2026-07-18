const SESSION_KEY = 'unkeep-relay-session';

export interface RelaySession {
  endpoint: string;
  instanceId: string;
  deviceId: string;
  credential: string;
}

export interface RelayStatus { protocol: number; instanceId: string; initialized: boolean }
export interface DeviceCredential { id:string; name:string; revokedAt:string|null }
export interface ServiceCredential { id:string; name:string; createdAt:string; revokedAt:string|null }

function cleanEndpoint(value: string): string {
  const url = new URL(value || window.location.origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('The sync server must use HTTPS');
  }
  return url.origin;
}

export class RelayClient {
  readonly endpoint: string;
  constructor(endpoint: string, private readonly credential?: string) { this.endpoint = cleanEndpoint(endpoint); }

  private async request<T>(path: string, init: RequestInit = {}, authorization?: string): Promise<T> {
    const response = await fetch(`${this.endpoint}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(this.credential ? { authorization: `Device ${this.credential}` } : {}), ...(authorization ? { authorization } : {}), ...init.headers }
    });
    const value = response.status === 204 ? {} : await response.json();
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
  changes(since: number) { return this.request<{changes:Array<{kind:'note'|'attachment';id:string;noteId?:string;envelope:unknown;deleted:boolean;revision:number}>;cursor:number}>(`/changes?since=${since}`); }
  putNote(id:string, value:unknown) { return this.request<{revision:number}>(`/notes/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  putAttachment(id:string, value:unknown) { return this.request<{revision:number}>(`/attachments/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  getAttachment(id:string) { return this.request<{noteId:string;envelope:unknown;deleted:boolean;revision:number}>(`/attachments/${encodeURIComponent(id)}`); }
  createPairing(value:unknown) { return this.request<{requestId:string;code:string;pollSecret:string;expiresAt:string}>('/pairings',{method:'POST',body:JSON.stringify(value)}); }
  pollPairing(id:string, secret:string) { return this.request<{response:unknown;deviceCredential:string|null;consumed:boolean}>(`/pairings/${id}?secret=${encodeURIComponent(secret)}`); }
  pairingByCode(code:string) { return this.request<{id:string;deviceId:string;deviceName:string;publicKey:JsonWebKey;expiresAt:string}>(`/pairings/code/${encodeURIComponent(code)}`); }
  approvePairing(id:string,response:unknown) { return this.request(`/pairings/${id}/approve`,{method:'POST',body:JSON.stringify({response})}); }
  consumePairing(id:string) { return this.request(`/pairings/${id}/consume`,{method:'POST',body:'{}'}); }
}

export function loadRelaySession(): RelaySession | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as RelaySession | null; } catch { return null; }
}
export function saveRelaySession(session: RelaySession): void { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
export function clearRelaySession(): void { localStorage.removeItem(SESSION_KEY); }
export function defaultRelayEndpoint(): string { return localStorage.getItem('unkeep-relay-endpoint') || window.location.origin; }
export function saveRelayEndpoint(endpoint:string): void { localStorage.setItem('unkeep-relay-endpoint', cleanEndpoint(endpoint)); }
