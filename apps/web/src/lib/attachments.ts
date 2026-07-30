import type { NoteAttachment } from '@unkeep/core';

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

const SAFE_INLINE_IMAGE_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
]);

function normalizedMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

export function isImageAttachment(attachment: Pick<NoteAttachment, 'mimeType'>): boolean {
  return SAFE_INLINE_IMAGE_TYPES.has(normalizedMimeType(attachment.mimeType));
}

/**
 * Object URLs inherit the application's origin. Treat every untrusted or
 * active-content MIME type as a download so an attachment cannot become a
 * same-origin HTML/SVG execution surface if a browser ignores the filename.
 */
export function safeAttachmentBlobType(
  attachment: Pick<NoteAttachment, 'mimeType'>,
): string {
  const mimeType = normalizedMimeType(attachment.mimeType);
  return SAFE_INLINE_IMAGE_TYPES.has(mimeType) ? mimeType : 'application/octet-stream';
}

export function hasLocalAttachmentUrl(
  attachment: NoteAttachment,
): attachment is NoteAttachment & { url: string } {
  return typeof attachment.url === 'string' && attachment.url.startsWith('blob:');
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function attachmentSizeError(file: Pick<File, 'name' | 'size'>): string | null {
  if (file.size <= MAX_ATTACHMENT_SIZE) return null;
  return `${file.name} is too large. Attachments must be 25 MB or smaller.`;
}
