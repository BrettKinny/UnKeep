import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const typescript = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');

test('public package declarations remain portable for downstream emit', () => {
  const temporaryRoot = mkdtempSync(join(repositoryRoot, '.package-declaration-test-'));
  const source = join(temporaryRoot, 'consumer.ts');

  try {
    writeFileSync(source, `import { RelayClient } from '@unkeep/client';
import { LocalOnlyAdapter } from '@unkeep/core/experimental';

export function stageAttachment(client: RelayClient) {
  return client.stageNoteAttachment('mutation', 'attachment', {
    noteId: 'note',
    envelope: {},
  });
}

export function localConfigKeys() {
  return new LocalOnlyAdapter().configSchema.map((field) => field.key);
}
`);

    const result = spawnSync(process.execPath, [
      typescript,
      source,
      '--declaration',
      '--emitDeclarationOnly',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--outDir', join(temporaryRoot, 'types'),
      '--skipLibCheck',
      '--strict',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    assert.equal(result.status, 0, details);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
