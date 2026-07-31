import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';
import { validateNoteId, isValidNoteId } from '../validation.js';

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function parseConfig(config: AdapterConfig): S3Config {
  return {
    endpoint: (config.endpoint as string).replace(/\/$/, ''),
    region: (config.region as string) || 'us-east-1',
    bucket: config.bucket as string,
    prefix: ((config.prefix as string) || 'notes/').replace(/\/$/, '') + '/',
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
  };
}

// Minimal AWS Signature V4 implementation
async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  let kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key).buffer, dateStamp);
  let kRegion = await hmacSha256(kDate, region);
  let kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  config: S3Config
): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = await sha256(body);

  const signedHeaderKeys = Object.keys(headers).sort().map(k => k.toLowerCase());
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');

  const canonicalRequest = [
    method,
    url.pathname,
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  const signingKey = await getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

export class S3Adapter implements StorageAdapter {
  id = 's3';
  displayName = 'S3-Compatible Storage';
  description = 'Store notes in any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Backblaze B2).';

  configSchema: ConfigField[] = [
    {
      key: 'endpoint',
      label: 'Endpoint URL',
      type: 'url',
      placeholder: 'https://s3.us-east-1.amazonaws.com',
      helpText: 'S3 endpoint URL. For MinIO: your server URL. For R2: https://<account-id>.r2.cloudflarestorage.com',
      required: true,
    },
    {
      key: 'region',
      label: 'Region',
      type: 'text',
      placeholder: 'us-east-1',
      helpText: 'AWS region. Use "auto" for Cloudflare R2.',
    },
    {
      key: 'bucket',
      label: 'Bucket Name',
      type: 'text',
      placeholder: 'my-notes',
      helpText: 'The S3 bucket name. Must already exist.',
      required: true,
    },
    {
      key: 'prefix',
      label: 'Key Prefix',
      type: 'text',
      placeholder: 'notes/',
      helpText: 'Object key prefix (folder path). Defaults to "notes/".',
    },
    {
      key: 'accessKeyId',
      label: 'Access Key ID',
      type: 'text',
      placeholder: 'AKIA...',
      helpText: 'Your S3 access key ID.',
      required: true,
    },
    {
      key: 'secretAccessKey',
      label: 'Secret Access Key',
      type: 'password',
      placeholder: '',
      helpText: 'Your S3 secret access key.',
      required: true,
    },
  ];

  private config: S3Config | null = null;

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const url = new URL(`${c.endpoint}/${c.bucket}?list-type=2&max-keys=1`);
      const headers: Record<string, string> = { host: url.host };
      const signed = await signRequest('GET', url, headers, '', c);
      const res = await fetch(url.toString(), { headers: signed });
      if (!res.ok) {
        return { valid: false, error: `Bucket access failed (${res.status}): ${await res.text()}` };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  private objectUrl(key: string): URL {
    if (!this.config) throw new Error('S3Adapter not initialized');
    return new URL(`${this.config.endpoint}/${this.config.bucket}/${key}`);
  }

  async listNotes(): Promise<NoteMetadata[]> {
    if (!this.config) throw new Error('S3Adapter not initialized');
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}?list-type=2&prefix=${encodeURIComponent(this.config.prefix)}`);
    const headers: Record<string, string> = { host: url.host };
    const signed = await signRequest('GET', url, headers, '', this.config);
    const res = await fetch(url.toString(), { headers: signed });

    if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);

    const xml = await res.text();
    const notes: NoteMetadata[] = [];

    // Parse XML response for <Key> elements
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(xml)) !== null) {
      const key = match[1];
      if (key.endsWith('.json')) {
        const id = key.replace(this.config.prefix, '').replace(/\.json$/, '');
        if (!isValidNoteId(id)) continue;
        notes.push({ id, updatedAt: 0 });
      }
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    validateNoteId(id);
    if (!this.config) throw new Error('S3Adapter not initialized');
    const key = `${this.config.prefix}${id}.json`;
    const url = this.objectUrl(key);
    const headers: Record<string, string> = { host: url.host };
    const signed = await signRequest('GET', url, headers, '', this.config);
    const res = await fetch(url.toString(), { headers: signed });

    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);
    return res.json();
  }

  async saveNote(note: Note): Promise<void> {
    validateNoteId(note.id);
    if (!this.config) throw new Error('S3Adapter not initialized');
    const key = `${this.config.prefix}${note.id}.json`;
    const url = this.objectUrl(key);
    const body = JSON.stringify(note);
    const headers: Record<string, string> = {
      host: url.host,
      'content-type': 'application/json',
    };
    const signed = await signRequest('PUT', url, headers, body, this.config);
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: signed,
      body,
    });

    if (!res.ok) throw new Error(`Failed to save note ${note.id}: ${res.status}`);
  }

  async deleteNote(id: string): Promise<void> {
    validateNoteId(id);
    if (!this.config) throw new Error('S3Adapter not initialized');
    const key = `${this.config.prefix}${id}.json`;
    const url = this.objectUrl(key);
    const headers: Record<string, string> = { host: url.host };
    const signed = await signRequest('DELETE', url, headers, '', this.config);
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: signed,
    });

    if (!res.ok) throw new Error(`Failed to delete note ${id}: ${res.status}`);
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
