export interface Note {
  id: string;
  content: string;
  createdAt: number; // unix timestamp ms
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  color?: NoteColor;
  checkboxes?: ChecklistItem[];
  deleted?: boolean; // soft delete tombstone
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
