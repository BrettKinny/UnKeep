import { noteStore } from './noteStore.svelte.js';
import { toastStore } from './toast.svelte.js';

/**
 * Move a note to Trash and offer an undo toast.
 *
 * Shared by the card's Trash button and the delete keyboard shortcut so both
 * paths stay recoverable in the same way.
 */
export async function trashNoteWithUndo(id: string): Promise<boolean> {
  if (!await noteStore.trashNote(id)) return false;
  toastStore.show('Moved to Trash', {
    action: {
      label: 'Undo',
      fn: () => void noteStore.restoreTrashedNote(id),
    },
    timeout: 5000,
  });
  return true;
}
