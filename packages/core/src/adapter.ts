import type { Note, NoteMetadata } from './types.js';

export interface AdapterConfig {
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number';
  placeholder?: string;
  helpText?: string;
  required?: boolean;
}

export interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  requiresSecret: boolean;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface StorageAdapter {
  id: string;
  displayName: string;
  description: string;
  configSchema: ConfigField[];
  oauthConfig?: OAuthProviderConfig;
  init(config: AdapterConfig): Promise<void>;
  validate(config: AdapterConfig): Promise<ValidationResult>;
  listNotes(): Promise<NoteMetadata[]>;
  getNote(id: string): Promise<Note>;
  saveNote(note: Note): Promise<void>;
  /** Persist an import batch in one storage transaction, or reject without writing any note. */
  saveNotesAtomically?(notes: Note[]): Promise<void>;
  deleteNote(id: string): Promise<void>;
  sync(): Promise<SyncResult>;
  getAllNotes?(): Promise<Note[]>;
}
