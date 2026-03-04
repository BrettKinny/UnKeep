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

export interface StorageAdapter {
  id: string;
  displayName: string;
  description: string;
  configSchema: ConfigField[];
  init(config: AdapterConfig): Promise<void>;
  validate(config: AdapterConfig): Promise<ValidationResult>;
  listNotes(): Promise<NoteMetadata[]>;
  getNote(id: string): Promise<Note>;
  saveNote(note: Note): Promise<void>;
  deleteNote(id: string): Promise<void>;
  sync(): Promise<SyncResult>;
}
