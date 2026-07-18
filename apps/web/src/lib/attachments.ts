import type { NoteAttachment } from '@unkeep/core';

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export function isImageAttachment(attachment: Pick<NoteAttachment, 'mimeType'>): boolean {
  return attachment.mimeType.toLowerCase().startsWith('image/');
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
