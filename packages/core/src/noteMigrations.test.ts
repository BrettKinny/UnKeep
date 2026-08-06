import { describe, expect, it } from 'vitest';
import {
  CURRENT_NOTE_SCHEMA_VERSION,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_ITEM_TEXT_LENGTH,
  MAX_ATTACHMENT_MIME_TYPE_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_ATTACHMENT_SIZE,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_LABEL_LENGTH,
  MAX_NOTE_LABELS,
  MAX_NOTE_TEXT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  normalizeNoteRecord,
  UnsupportedNoteSchemaVersionError,
} from './noteMigrations.js';

describe('normalizeNoteRecord', () => {
  it('upgrades an unversioned legacy note without mutating the stored record', () => {
    const legacy = {
      id: 'legacy-note',
      content: 'Old but useful',
      createdAt: 100,
      updatedAt: 200,
    };

    expect(normalizeNoteRecord(legacy)).toEqual({
      ...legacy,
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
      pinned: false,
      archived: false,
    });
    expect(legacy).not.toHaveProperty('schemaVersion');
  });

  it('rejects a record written by a newer note schema', () => {
    expect(() => normalizeNoteRecord({
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION + 1,
      id: 'from-the-future',
      content: 'Do not downgrade me',
      createdAt: 100,
      updatedAt: 200,
      pinned: false,
      archived: false,
    })).toThrow(UnsupportedNoteSchemaVersionError);
  });

  it('keeps only validated portable fields and strips attachment URLs', () => {
    expect(normalizeNoteRecord({
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
      id: 'hostile-note',
      title: 'Portable title',
      content: 'Portable content',
      createdAt: 100,
      updatedAt: 200,
      pinned: true,
      archived: false,
      color: 'teal',
      checkboxes: [{ id: 'item-one', text: 'Safe text', checked: false, injected: true }],
      labels: ['work'],
      images: [{
        id: 'attachment-one',
        name: 'payload.txt',
        mimeType: 'text/plain',
        size: 7,
        url: 'javascript:alert(document.domain)',
        injected: true,
      }],
      trashedAt: 300,
      deleted: false,
      injected: '<script>alert(1)</script>',
    })).toEqual({
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
      id: 'hostile-note',
      title: 'Portable title',
      content: 'Portable content',
      createdAt: 100,
      updatedAt: 200,
      pinned: true,
      archived: false,
      color: 'teal',
      checkboxes: [{ id: 'item-one', text: 'Safe text', checked: false }],
      labels: ['work'],
      images: [{
        id: 'attachment-one',
        name: 'payload.txt',
        mimeType: 'text/plain',
        size: 7,
      }],
      trashedAt: 300,
      deleted: false,
    });
  });

  it.each([
    ['title', { title: 42 }],
    ['color', { color: 'ultraviolet' }],
    ['checkboxes', { checkboxes: [{ id: 'item-one', text: 'text', checked: 'yes' }] }],
    ['labels', { labels: ['valid', 42] }],
    ['images', { images: [{ id: 'attachment-one', name: 'file', mimeType: 'text/plain', size: -1 }] }],
    ['deleted', { deleted: 'yes' }],
    ['trashedAt', { trashedAt: -1 }],
  ])('rejects malformed optional %s', (_field, invalid) => {
    expect(() => normalizeNoteRecord({
      id: 'invalid-note',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      ...invalid,
    })).toThrow('Invalid note record');
  });

  it('rejects a permanent tombstone that also claims to be recoverable', () => {
    expect(() => normalizeNoteRecord({
      id: 'ambiguous-deletion',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      trashedAt: 150,
      deleted: true,
    })).toThrow('permanently deleted notes cannot remain in Trash');
  });

  it.each([
    ['note', { id: '../escape' }],
    ['checklist item', { checkboxes: [{ id: '../item', text: '', checked: false }] }],
    ['attachment', { images: [{ id: '../file', name: 'file', mimeType: 'text/plain', size: 0 }] }],
  ])('rejects a non-route-safe %s identifier', (_field, invalid) => {
    expect(() => normalizeNoteRecord({
      id: 'safe-note',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      ...invalid,
    })).toThrow('Invalid note record');
  });

  it.each([
    ['checklist item', {
      checkboxes: [
        { id: 'duplicate', text: 'first', checked: false },
        { id: 'duplicate', text: 'second', checked: true },
      ],
    }],
    ['attachment', {
      images: [
        { id: 'duplicate', name: 'a', mimeType: 'text/plain', size: 0 },
        { id: 'duplicate', name: 'b', mimeType: 'text/plain', size: 0 },
      ],
    }],
  ])('rejects duplicate %s identifiers', (_field, invalid) => {
    expect(() => normalizeNoteRecord({
      id: 'safe-note',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      ...invalid,
    })).toThrow('duplicate');
  });

  it.each([
    ['title length', { title: 'x'.repeat(MAX_NOTE_TITLE_LENGTH + 1) }],
    ['aggregate text length', {
      content: 'x'.repeat(MAX_NOTE_TEXT_LENGTH),
      labels: ['x'],
    }],
    ['checklist count', {
      checkboxes: Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }),
    }],
    ['label count', {
      labels: Array.from({ length: MAX_NOTE_LABELS + 1 }),
    }],
    ['attachment count', {
      images: Array.from({ length: MAX_NOTE_ATTACHMENTS + 1 }),
    }],
  ])('rejects an excessive %s', (_field, invalid) => {
    expect(() => normalizeNoteRecord({
      id: 'safe-note',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      ...invalid,
    })).toThrow('Invalid note record');
  });

  it.each([
    ['content length', { content: 'x'.repeat(MAX_NOTE_CONTENT_LENGTH + 1) }],
    ['checklist item text length', {
      checkboxes: [{
        id: 'large-item',
        text: 'x'.repeat(MAX_CHECKLIST_ITEM_TEXT_LENGTH + 1),
        checked: false,
      }],
    }],
    ['label length', { labels: ['x'.repeat(MAX_NOTE_LABEL_LENGTH + 1)] }],
    ['attachment name length', {
      images: [{
        id: 'large-name',
        name: 'x'.repeat(MAX_ATTACHMENT_NAME_LENGTH + 1),
        mimeType: 'application/octet-stream',
        size: 0,
      }],
    }],
    ['attachment media type length', {
      images: [{
        id: 'large-media-type',
        name: 'file',
        mimeType: 'x'.repeat(MAX_ATTACHMENT_MIME_TYPE_LENGTH + 1),
        size: 0,
      }],
    }],
    ['attachment byte size', {
      images: [{
        id: 'large-attachment',
        name: 'file',
        mimeType: 'application/octet-stream',
        size: MAX_NOTE_ATTACHMENT_SIZE + 1,
      }],
    }],
  ])('rejects an excessive %s before returning a portable note', (_field, invalid) => {
    expect(() => normalizeNoteRecord({
      id: 'safe-note',
      content: '',
      createdAt: 100,
      updatedAt: 200,
      ...invalid,
    })).toThrow('Invalid note record');
  });
});
