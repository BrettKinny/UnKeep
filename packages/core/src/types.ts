export interface Note {
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
  images?: NoteImage[];
  deleted?: boolean; // soft delete tombstone
}

export interface NoteImage {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Local object URL or data URL. Remote images are resolved by the encrypted attachment store. */
  url?: string;
}

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
