import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  readStagedClip,
  removeStagedClip,
  stageClipFile,
  sweepStagedClips,
} from './clipStaging.js';
import { JsonFileClientStorage } from './storage.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function context(): Promise<{
  directory: string;
  storage: JsonFileClientStorage;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'unkeep-clip-stage-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    storage: new JsonFileClientStorage(join(directory, 'config.json')),
  };
}

test('durably stages and verifies one bounded private snapshot', async () => {
  const { directory, storage } = await context();
  const source = join(directory, 'source.bin');
  const bytes = Uint8Array.from([0, 255, 1, 2, 3, 128]);
  await writeFile(source, bytes);

  const staged = await stageClipFile(
    storage,
    source,
    'source.bin',
    'clip-one',
    1024,
  );
  const path = join(directory, 'clip-staging', staged.fileName);

  expect(staged).toMatchObject({ fileName: 'clip-clip-one.bin', size: bytes.byteLength });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readStagedClip(storage, staged)).toEqual(bytes);

  await removeStagedClip(storage, staged.fileName);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a growing source is stopped at maximum plus one and leaves no staging file', async () => {
  const { directory, storage } = await context();
  const source = join(directory, 'growing.bin');
  await writeFile(source, 'a');
  let expanded = false;

  await expect(stageClipFile(
    storage,
    source,
    'growing.bin',
    'clip-growing',
    1024,
    {
      afterChunk: async () => {
        if (expanded) return;
        expanded = true;
        await appendFile(source, Buffer.alloc(1024, 1));
      },
    },
  )).rejects.toThrow('File changed while being clipped');

  await expect(
    readFile(join(directory, 'clip-staging', 'clip-clip-growing.bin')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('verification fails closed after staged bytes or permissions change', async () => {
  const { directory, storage } = await context();
  const source = join(directory, 'source.bin');
  await writeFile(source, 'trusted');
  const staged = await stageClipFile(
    storage,
    source,
    'source.bin',
    'clip-tamper',
    1024,
  );
  const path = join(directory, 'clip-staging', staged.fileName);

  await writeFile(path, 'changed');
  await expect(readStagedClip(storage, staged)).rejects.toThrow(
    /unsafe or changed|checksum does not match/,
  );

  await writeFile(path, 'trusted');
  await chmod(path, 0o644);
  await expect(readStagedClip(storage, staged)).rejects.toThrow(
    'staging file is unsafe or changed',
  );
});

test('sweeps only safely named unreferenced staging files', async () => {
  const { directory, storage } = await context();
  const firstSource = join(directory, 'first.bin');
  const secondSource = join(directory, 'second.bin');
  await writeFile(firstSource, 'first');
  await writeFile(secondSource, 'second');
  const retained = await stageClipFile(
    storage,
    firstSource,
    'first.bin',
    'retained',
    1024,
  );
  const orphan = await stageClipFile(
    storage,
    secondSource,
    'second.bin',
    'orphan',
    1024,
  );

  await sweepStagedClips(storage, new Set([retained.fileName]));
  expect(await readStagedClip(storage, retained)).toEqual(
    new TextEncoder().encode('first'),
  );
  await expect(
    readFile(join(directory, 'clip-staging', orphan.fileName)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
