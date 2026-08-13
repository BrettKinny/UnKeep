import { createHash } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { validateNoteId } from '@unkeep/core';
import { ensurePrivateDirectory, type JsonFileClientStorage } from './storage.js';

const COPY_CHUNK_SIZE = 64 * 1024;
const STAGING_DIRECTORY_NAME = 'clip-staging';
const STAGING_FILE_PATTERN = /^clip-([A-Za-z0-9_-]{1,128})\.bin$/;

export interface StagedClip {
  fileName: string;
  sha256: string;
  size: number;
}

export interface StageClipHooks {
  afterChunk?: (copiedBytes: number) => void | Promise<void>;
}

function stagingDirectory(storage: JsonFileClientStorage): string {
  return join(dirname(storage.filePath), STAGING_DIRECTORY_NAME);
}

export function stagedClipFileName(attachmentId: string): string {
  validateNoteId(attachmentId);
  return `clip-${attachmentId}.bin`;
}

export function validateStagedClipFileName(fileName: string): string {
  const match = fileName.match(STAGING_FILE_PATTERN);
  if (!match || basename(fileName) !== fileName) {
    throw new Error('Stored interrupted clip staging name is invalid');
  }
  validateNoteId(match[1]);
  return fileName;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform === 'win32'
      || ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) throw new Error('Unable to write the staged clip');
    offset += bytesWritten;
  }
}

export async function stageClipFile(
  storage: JsonFileClientStorage,
  sourcePath: string,
  displayName: string,
  attachmentId: string,
  maximumSize: number,
  hooks: StageClipHooks = {},
): Promise<StagedClip> {
  const directory = stagingDirectory(storage);
  const fileName = stagedClipFileName(attachmentId);
  const destination = join(directory, fileName);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let staged: Awaited<ReturnType<typeof open>> | undefined;
  let stagedCreated = false;
  let completed = false;

  try {
    const sourceEntry = await lstat(sourcePath);
    if (sourceEntry.isSymbolicLink()) {
      throw Object.assign(
        new Error(`Refusing to clip a symbolic link: ${sourcePath}`),
        { code: 'ELOOP' },
      );
    }
    source = await open(
      sourcePath,
      fsConstants.O_RDONLY | noFollow | nonBlocking,
    );
    const before = await source.stat();
    if (
      !sourceEntry.isFile()
      || !before.isFile()
      || sourceEntry.dev !== before.dev
      || sourceEntry.ino !== before.ino
    ) {
      throw new Error(`Not a regular file: ${sourcePath}`);
    }
    if (before.size > maximumSize) {
      throw new Error(
        `${displayName} is too large. Attachments must be 25 MB or smaller.`,
      );
    }

    await ensurePrivateDirectory(directory);
    staged = await open(
      destination,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | noFollow,
      0o600,
    );
    stagedCreated = true;
    await staged.chmod(0o600);

    const digest = createHash('sha256');
    let copied = 0;
    while (copied <= maximumSize) {
      const remaining = maximumSize + 1 - copied;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_SIZE, remaining));
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await writeAll(staged, chunk);
      copied += bytesRead;
      await hooks.afterChunk?.(copied);
    }

    const after = await source.stat();
    if (
      copied > maximumSize
      || copied !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`File changed while being clipped: ${sourcePath}`);
    }

    await staged.sync();
    await staged.close();
    staged = undefined;
    await syncDirectory(directory);
    completed = true;
    return {
      fileName,
      sha256: digest.digest('hex'),
      size: copied,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${sourcePath}`);
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Refusing to clip a symbolic link: ${sourcePath}`);
    }
    throw error;
  } finally {
    await source?.close();
    await staged?.close();
    if (stagedCreated && !completed) {
      await unlink(destination).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await syncDirectory(directory);
    }
  }
}

export async function readStagedClip(
  storage: JsonFileClientStorage,
  staged: StagedClip,
): Promise<Uint8Array<ArrayBuffer>> {
  validateStagedClipFileName(staged.fileName);
  if (
    !Number.isSafeInteger(staged.size)
    || staged.size < 0
    || staged.size > 25 * 1024 * 1024
    || !/^[0-9a-f]{64}$/.test(staged.sha256)
  ) {
    throw new Error('Stored interrupted clip staging metadata is invalid');
  }

  const path = join(stagingDirectory(storage), staged.fileName);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Interrupted clip staging file is unsafe or changed');
    }
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || entry.dev !== before.dev
      || entry.ino !== before.ino
      || (before.mode & 0o077) !== 0
      || before.size !== staged.size
    ) {
      throw new Error('Interrupted clip staging file is unsafe or changed');
    }

    const buffer = Buffer.allocUnsafe(staged.size + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (
      total !== staged.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Interrupted clip staging file is unsafe or changed');
    }
    const bytes = buffer.subarray(0, total);
    if (createHash('sha256').update(bytes).digest('hex') !== staged.sha256) {
      throw new Error('Interrupted clip staging file checksum does not match');
    }
    return Uint8Array.from(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Interrupted clip staging file is missing');
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('Interrupted clip staging file is unsafe or changed');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function removeStagedClip(
  storage: JsonFileClientStorage,
  fileName: string,
): Promise<void> {
  validateStagedClipFileName(fileName);
  const directory = stagingDirectory(storage);
  await unlink(join(directory, fileName)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await syncDirectory(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function sweepStagedClips(
  storage: JsonFileClientStorage,
  retainedFileNames: ReadonlySet<string>,
): Promise<void> {
  const directory = stagingDirectory(storage);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  let removed = false;
  for (const entry of entries) {
    if (!STAGING_FILE_PATTERN.test(entry.name) || retainedFileNames.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`Unsafe entry in the UnKeep clip staging directory: ${entry.name}`);
    }
    await unlink(path);
    removed = true;
  }
  if (removed) await syncDirectory(directory);
}
