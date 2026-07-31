export interface RelaySession {
  endpoint: string;
  instanceId: string;
  deviceId: string;
  credential: string;
  pendingPairingRequestId?: string;
}

export interface RelayStatus { protocol: number; instanceId: string; initialized: boolean }
export interface DeviceCredential { id:string; name:string; revokedAt:string|null; approvedByDeviceId:string|null }
export type ServiceCredentialScope = 'read-only' | 'read-write';
export interface ServiceCredential { id:string; name:string; scope:ServiceCredentialScope; createdAt:string; revokedAt:string|null; issuedByDeviceId:string|null }
export type RelayChange =
  | { kind:'note'; id:string; noteId?:string; envelope:unknown; deleted:boolean; revision:number }
  | { kind:'attachment'; id:string; noteId?:string; deleted:boolean; revision:number };

export interface RelayClientOptions {
  allowInsecure?: boolean;
}

export interface RelayAttachmentStageRequest {
  noteId: string;
  envelope: unknown;
}

export interface RelayAttachmentStageReceipt {
  stageHash: string;
}

export interface RelayCompoundAttachment {
  id: string;
  stageHash: string;
}

export interface RelayCompoundNoteRequest {
  mutationId: string;
  baseRevision: number;
  envelope: unknown;
  deleted: false;
  newAttachments: RelayCompoundAttachment[];
}

export interface RelayCompoundAttachmentRevision {
  id: string;
  revision: number;
}

export interface RelayCompoundNoteReceipt {
  revision: number;
  attachmentRevisions: RelayCompoundAttachmentRevision[];
}

export class RelayHttpError extends Error {
  readonly name:string = 'RelayHttpError';

  constructor(readonly status:number, readonly code:string) {
    super(code);
  }
}

export class RecordConflictError extends RelayHttpError {
  override readonly name:string = 'RecordConflictError';

  constructor(readonly currentRevision:number) {
    super(409, 'record_conflict');
  }
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

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
    const value = response.status === 204 ? {} : await response.json() as { error?: string; currentRevision?: number };
    if (!response.ok) {
      const code = value.error || `Sync server returned ${response.status}`;
      if (response.status === 409 && code === 'record_conflict' && Number.isSafeInteger(value.currentRevision) && value.currentRevision! >= 0) {
        throw new RecordConflictError(value.currentRevision!);
      }
      throw new RelayHttpError(response.status, code);
    }
    return value as T;
  }

  status(signal?:AbortSignal) { return this.request<RelayStatus>('/status',{signal}); }
  claimSetup(setupToken: string, expectedInstanceId: string, deviceId: string, name: string) {
    return this.request<{instanceId:string;deviceCredential:string}>('/setup/claim', { method:'POST', body:JSON.stringify({expectedInstanceId,deviceId,name}) }, `Setup ${setupToken}`);
  }
  reclaimSetup(recoveryToken: string, expectedInstanceId: string, deviceId: string, name: string) {
    return this.request<{instanceId:string;deviceCredential:string}>('/setup/reclaim', { method:'POST', body:JSON.stringify({expectedInstanceId,deviceId,name}) }, `Recovery ${recoveryToken}`);
  }
  vault() { return this.request<{vaultId:string}>('/vault'); }
  devices(signal?:AbortSignal) { return this.request<{devices:DeviceCredential[]}>('/devices',{signal}); }
  revokeDevice(id:string,signal?:AbortSignal) { return this.request(`/devices/${encodeURIComponent(id)}`,{method:'DELETE',signal}); }
  revokeAllDevices() { return this.request('/devices',{method:'DELETE'}); }
  serviceCredentials() { return this.request<{serviceCredentials:ServiceCredential[]}>('/service-credentials'); }
  mintServiceCredential(name:string, scope:ServiceCredentialScope = 'read-only') { return this.request<{id:string;name:string;scope:ServiceCredentialScope;createdAt:string;issuedByDeviceId:string;serviceCredential:string}>('/service-credentials',{method:'POST',body:JSON.stringify({name,scope})}); }
  revokeServiceCredential(id:string) { return this.request(`/service-credentials/${encodeURIComponent(id)}`,{method:'DELETE'}); }
  changes(since: number) { return this.request<{changes:RelayChange[];cursor:number}>(`/changes?since=${since}`); }
  putNote(id:string, value:unknown) { return this.request<{revision:number}>(`/notes/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  putAttachment(id:string, value:unknown) { return this.request<{revision:number}>(`/attachments/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(value)}); }
  async stageNoteAttachment(mutationId:string, id:string, value:RelayAttachmentStageRequest): Promise<RelayAttachmentStageReceipt> {
    const receipt = await this.request<unknown>(
      `/note-mutations/${encodeURIComponent(mutationId)}/attachments/${encodeURIComponent(id)}`,
      {method:'PUT',body:JSON.stringify(value)},
    );
    if (!hasExactKeys(receipt, ['stageHash'])
      || typeof receipt.stageHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.stageHash)) {
      throw new Error('Relay returned an invalid attachment stage receipt');
    }
    return {stageHash:receipt.stageHash};
  }
  async finalizeNoteWithAttachments(id:string, value:RelayCompoundNoteRequest): Promise<RelayCompoundNoteReceipt> {
    const receipt = await this.request<unknown>(
      `/notes/${encodeURIComponent(id)}/compound`,
      {method:'PUT',body:JSON.stringify(value)},
    );
    if (!hasExactKeys(receipt, ['revision', 'attachmentRevisions'])
      || !isPositiveRevision(receipt.revision)
      || !Array.isArray(receipt.attachmentRevisions)
      || receipt.attachmentRevisions.length !== value.newAttachments.length) {
      throw new Error('Relay returned an invalid compound note receipt');
    }

    const attachmentRevisions:RelayCompoundAttachmentRevision[] = [];
    for (let index = 0; index < receipt.attachmentRevisions.length; index += 1) {
      const attachment = receipt.attachmentRevisions[index];
      const expectedId = value.newAttachments[index]?.id;
      if (!hasExactKeys(attachment, ['id', 'revision'])
        || attachment.id !== expectedId
        || !isPositiveRevision(attachment.revision)
        || attachment.revision !== receipt.revision - receipt.attachmentRevisions.length + index) {
        throw new Error('Relay returned an invalid compound note receipt');
      }
      attachmentRevisions.push({id:attachment.id,revision:attachment.revision});
    }
    return {revision:receipt.revision,attachmentRevisions};
  }
  getAttachment(id:string) { return this.request<{noteId:string;envelope:unknown;deleted:boolean;revision:number}>(`/attachments/${encodeURIComponent(id)}`); }
  createPairing(value:unknown) { return this.request<{requestId:string;code:string;pollSecret:string;expiresAt:string;instanceId:string}>('/pairings',{method:'POST',body:JSON.stringify(value)}); }
  pollPairing(id:string, secret:string, signal?:AbortSignal) { return this.request<{instanceId:string;response:unknown}>(`/pairings/${id}`, { signal, headers:{'unkeep-pairing-secret':secret} }); }
  cancelPairing(id:string, secret:string) { return this.request(`/pairings/${id}`, { method:'DELETE', headers:{'unkeep-pairing-secret':secret} }); }
  pairingByCode(code:string) { return this.request<{id:string;instanceId:string;deviceId:string;deviceName:string;publicKey:JsonWebKey;expiresAt:string}>(`/pairings/code/${encodeURIComponent(code)}`); }
  approvePairing(id:string,response:unknown) { return this.request(`/pairings/${id}/approve`,{method:'POST',body:JSON.stringify({response})}); }
  consumePairing(id:string,signal?:AbortSignal) { return this.request(`/pairings/${id}/consume`,{method:'POST',body:'{}',signal}); }
}
