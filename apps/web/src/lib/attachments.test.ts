import { describe, expect, it } from 'vitest';
import {
  attachmentSizeError,
  formatAttachmentSize,
  isImageAttachment,
  MAX_ATTACHMENT_SIZE,
} from './attachments';

describe('attachments', () => {
  it('distinguishes inline images from downloadable files by MIME type', () => {
    expect(isImageAttachment({ mimeType: 'image/png' })).toBe(true);
    expect(isImageAttachment({ mimeType: 'application/pdf' })).toBe(false);
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
});
