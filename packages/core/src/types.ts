export interface Note {
  /** Added at persistence boundaries. Missing means the legacy unversioned schema. */
  schemaVersion?: number;
  id: string;
  title?: string;
  content: string;
  createdAt: number; // unix timestamp ms
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  color?: NoteColor;
  checkboxes?: ChecklistItem[];
  labels?: string[];
  /** Stored as `images` for compatibility with existing notes, but may contain any file type. */
  images?: NoteAttachment[];
  deleted?: boolean; // soft delete tombstone
}

export interface NoteAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Local object URL or data URL. Remote files are resolved by the encrypted attachment store. */
  url?: string;
}

/** @deprecated Use NoteAttachment. Kept as a source-compatible alias for image integrations. */
export type NoteImage = NoteAttachment;

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export type NoteColor =
  | 'default'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'gray';

export interface NoteMetadata {
  id: string;
  updatedAt: number;
  deleted?: boolean;
}
