import { describe, expect, it } from 'vitest';
import { SHORTCUTS, SHORTCUT_GROUPS, matchShortcut, shortcutsFor } from './shortcuts.js';

const allKeys = SHORTCUTS.flatMap(shortcut => shortcut.keys);

describe('shortcut definitions', () => {
  it('never binds the same key twice', () => {
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('covers every declared group', () => {
    for (const group of SHORTCUT_GROUPS) {
      expect(shortcutsFor(group.context).length).toBeGreaterThan(0);
    }
  });

  it('uses arrow keys rather than vim keys for navigation', () => {
    const navigation = SHORTCUTS.filter(shortcut => shortcut.action.startsWith('move-'));
    expect(navigation.flatMap(shortcut => shortcut.keys).sort())
      .toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
    expect(allKeys).not.toContain('j');
    expect(allKeys).not.toContain('k');
  });

  it('moves notes to Trash with Delete and Backspace, not #', () => {
    const trash = SHORTCUTS.find(shortcut => shortcut.action === 'trash');
    expect(trash?.keys).toEqual(['Delete', 'Backspace']);
    expect(allKeys).not.toContain('#');
  });

  it('has no archive shortcut now that archive is gone', () => {
    expect(allKeys).not.toContain('a');
  });
});

describe('matchShortcut', () => {
  it('resolves global shortcuts without a selection', () => {
    expect(matchShortcut({ key: '?' })?.action).toBe('help');
    expect(matchShortcut({ key: '/' })?.action).toBe('search');
    expect(matchShortcut({ key: 'n' })?.action).toBe('new-note');
  });

  it('ignores unbound keys', () => {
    expect(matchShortcut({ key: 'z' })).toBeNull();
  });

  it('ignores modifier combinations so browser bindings still work', () => {
    expect(matchShortcut({ key: 'n', metaKey: true })).toBeNull();
    expect(matchShortcut({ key: 'n', ctrlKey: true })).toBeNull();
    expect(matchShortcut({ key: 'n', altKey: true })).toBeNull();
  });

  it('withholds selection-dependent shortcuts until a note is selected', () => {
    expect(matchShortcut({ key: 'p' })).toBeNull();
    expect(matchShortcut({ key: 'p' }, { hasSelection: true })?.action).toBe('pin');
    expect(matchShortcut({ key: 'Delete' }, { hasSelection: true })?.action).toBe('trash');
    expect(matchShortcut({ key: 'Backspace' }, { hasSelection: true })?.action).toBe('trash');
  });

  it('still moves the selection when nothing is selected yet', () => {
    expect(matchShortcut({ key: 'ArrowDown' })?.action).toBe('move-down');
  });

  it('suppresses everything but Escape while typing', () => {
    expect(matchShortcut({ key: 'n' }, { editingText: true })).toBeNull();
    expect(matchShortcut({ key: 'ArrowDown' }, { editingText: true })).toBeNull();
    expect(matchShortcut({ key: 'Backspace' }, { editingText: true, hasSelection: true })).toBeNull();
    expect(matchShortcut({ key: 'Escape' }, { editingText: true })?.action).toBe('dismiss');
  });

  it('suppresses everything but Escape while a modal or menu is open', () => {
    expect(matchShortcut({ key: 'n' }, { modalOpen: true })).toBeNull();
    expect(matchShortcut({ key: 'p' }, { modalOpen: true, hasSelection: true })).toBeNull();
    expect(matchShortcut({ key: 'Escape' }, { modalOpen: true })?.action).toBe('dismiss');
  });

  it('opens the selected note with Enter or e', () => {
    expect(matchShortcut({ key: 'Enter' }, { hasSelection: true })?.action).toBe('open');
    expect(matchShortcut({ key: 'e' }, { hasSelection: true })?.action).toBe('open');
  });

  it('never lets a keystroke change or delete a note in Trash', () => {
    const inTrash = { hasSelection: true, inTrash: true };
    expect(matchShortcut({ key: 'Delete' }, inTrash)).toBeNull();
    expect(matchShortcut({ key: 'Backspace' }, inTrash)).toBeNull();
    expect(matchShortcut({ key: 'p' }, inTrash)).toBeNull();
  });

  it('keeps browsing and viewing available in Trash', () => {
    const inTrash = { hasSelection: true, inTrash: true };
    expect(matchShortcut({ key: 'ArrowDown' }, inTrash)?.action).toBe('move-down');
    expect(matchShortcut({ key: 'Enter' }, inTrash)?.action).toBe('open');
    expect(matchShortcut({ key: '/' }, inTrash)?.action).toBe('search');
  });
});
