/**
 * Keyboard shortcut definitions and matching.
 *
 * Every shortcut in the app is declared here so the help dialog and the global
 * keydown handler never drift apart. The matcher is deliberately DOM-free so it
 * can be unit tested against plain objects.
 */

export type ShortcutContext = 'global' | 'grid';

export type ShortcutAction =
  | 'help'
  | 'search'
  | 'new-note'
  | 'dismiss'
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'open'
  | 'pin'
  | 'trash';

export interface ShortcutDefinition {
  action: ShortcutAction;
  /** `KeyboardEvent.key` values that trigger this shortcut. */
  keys: string[];
  /** Key caps rendered in the help dialog. */
  display: string[];
  description: string;
  context: ShortcutContext;
  /** Grid shortcuts that only make sense once a note is selected. */
  requiresSelection?: boolean;
  /**
   * Shortcuts that change a live note. Trash is read-only, and a keystroke must
   * never be able to permanently delete a note, so these are off there.
   */
  notInTrash?: boolean;
}

/** The subset of `KeyboardEvent` the matcher needs. */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { action: 'help', keys: ['?'], display: ['?'], description: 'Show keyboard shortcuts', context: 'global' },
  { action: 'search', keys: ['/'], display: ['/'], description: 'Focus search', context: 'global' },
  { action: 'new-note', keys: ['n'], display: ['n'], description: 'Create a new note', context: 'global' },
  { action: 'dismiss', keys: ['Escape'], display: ['Esc'], description: 'Close dialog, editor, or clear selection', context: 'global' },

  { action: 'move-up', keys: ['ArrowUp'], display: ['↑'], description: 'Select the note above', context: 'grid' },
  { action: 'move-down', keys: ['ArrowDown'], display: ['↓'], description: 'Select the note below', context: 'grid' },
  { action: 'move-left', keys: ['ArrowLeft'], display: ['←'], description: 'Select the note to the left', context: 'grid' },
  { action: 'move-right', keys: ['ArrowRight'], display: ['→'], description: 'Select the note to the right', context: 'grid' },
  { action: 'open', keys: ['Enter', 'e'], display: ['Enter', 'e'], description: 'Open the selected note', context: 'grid', requiresSelection: true },
  { action: 'pin', keys: ['p'], display: ['p'], description: 'Pin or unpin the selected note', context: 'grid', requiresSelection: true, notInTrash: true },
  { action: 'trash', keys: ['Delete', 'Backspace'], display: ['Del', 'Backspace'], description: 'Move the selected note to Trash', context: 'grid', requiresSelection: true, notInTrash: true },
];

export const SHORTCUT_GROUPS: { title: string; context: ShortcutContext }[] = [
  { title: 'Global', context: 'global' },
  { title: 'Note grid', context: 'grid' },
];

export function shortcutsFor(context: ShortcutContext): ShortcutDefinition[] {
  return SHORTCUTS.filter(shortcut => shortcut.context === context);
}

/**
 * True when the event target is somewhere the user is typing, so single-letter
 * shortcuts must not fire.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface MatchOptions {
  /** Focus is in a text field: only `Escape` still resolves. */
  editingText?: boolean;
  /** A note is currently selected in the grid. */
  hasSelection?: boolean;
  /** A modal or menu owns the keyboard: only `Escape` still resolves. */
  modalOpen?: boolean;
  /** The Trash view is showing: shortcuts that change a note are off. */
  inTrash?: boolean;
}

/**
 * Resolve a keydown to a shortcut, or `null` when nothing should happen.
 *
 * Events carrying Ctrl/Cmd/Alt are always ignored so browser and OS bindings
 * (Cmd+N, Ctrl+A, …) keep working.
 */
export function matchShortcut(event: ShortcutKeyEvent, options: MatchOptions = {}): ShortcutDefinition | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const match = SHORTCUTS.find(shortcut => shortcut.keys.includes(event.key));
  if (!match) return null;

  // While typing or inside a modal, Escape is the only shortcut left.
  if ((options.editingText || options.modalOpen) && match.action !== 'dismiss') return null;
  if (match.requiresSelection && !options.hasSelection) return null;
  if (match.notInTrash && options.inTrash) return null;

  return match;
}
