import { describe, expect, it } from 'vitest';
import {
  attachmentSizeError,
  formatAttachmentSize,
  hasLocalAttachmentUrl,
  isImageAttachment,
  MAX_ATTACHMENT_SIZE,
  safeAttachmentBlobType,
} from './attachments';

describe('attachments', () => {
  it('distinguishes inline images from downloadable files by MIME type', () => {
    expect(isImageAttachment({ mimeType: 'image/png' })).toBe(true);
    expect(isImageAttachment({ mimeType: 'application/pdf' })).toBe(false);
    expect(isImageAttachment({ mimeType: 'image/svg+xml' })).toBe(false);
  });

  it('mints active or untrusted attachment types as inert downloads', () => {
    expect(safeAttachmentBlobType({ mimeType: 'IMAGE/PNG; charset=binary' })).toBe('image/png');
    expect(safeAttachmentBlobType({ mimeType: 'image/svg+xml' })).toBe('application/octet-stream');
    expect(safeAttachmentBlobType({ mimeType: 'text/html' })).toBe('application/octet-stream');
    expect(safeAttachmentBlobType({ mimeType: 'application/pdf' })).toBe('application/octet-stream');
  });

  it('rejects files over 25 MiB with a clear message', () => {
    expect(attachmentSizeError({ name: 'archive.zip', size: MAX_ATTACHMENT_SIZE })).toBeNull();
    expect(attachmentSizeError({ name: 'archive.zip', size: MAX_ATTACHMENT_SIZE + 1 })).toBe(
      'archive.zip is too large. Attachments must be 25 MB or smaller.'
    );
  });

  it('formats chip sizes', () => {
    expect(formatAttachmentSize(500)).toBe('500 B');
    expect(formatAttachmentSize(1536)).toBe('1.5 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('only treats locally minted object URLs as renderable attachment URLs', () => {
    const base = { id: 'file', name: 'file.txt', mimeType: 'text/plain', size: 1 };

    expect(hasLocalAttachmentUrl({ ...base, url: 'blob:https://unkeep.example/random' })).toBe(true);
    expect(hasLocalAttachmentUrl({ ...base, url: 'javascript:alert(1)' })).toBe(false);
    expect(hasLocalAttachmentUrl({ ...base, url: 'data:text/html,<script>alert(1)</script>' })).toBe(false);
    expect(hasLocalAttachmentUrl({ ...base, url: 'https://attacker.example/file' })).toBe(false);
    expect(hasLocalAttachmentUrl(base)).toBe(false);
  });
});
