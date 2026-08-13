import { writeFileSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';

const [
  storageModuleUrl,
  filePath,
  readyPath,
  startPath,
  mode,
  detailPath = '',
  value = '1',
] = process.argv.slice(2);
if (!storageModuleUrl || !filePath || !readyPath || !startPath || !mode) {
  throw new Error('storage worker requires module, file, ready, start, and mode arguments');
}

const { JsonFileClientStorage } = await import(storageModuleUrl);
const storage = new JsonFileClientStorage(filePath, {
  lockRetryMs: 10,
  lockTimeoutMs: 2_000,
});

await writeFile(readyPath, '');
while (true) {
  try {
    await access(startPath);
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

if (mode === 'increment') {
  await storage.update('counter', current => Number(current ?? 0) + Number(value));
} else if (mode === 'transaction') {
  await storage.runExclusive(async () => {
    const current = await storage.get('transactionCounter');
    await new Promise(resolve => setTimeout(resolve, 25));
    await storage.set('transactionCounter', Number(current ?? 0) + Number(value));
  });
} else if (mode === 'hold') {
  await storage.set('holder', {
    toJSON() {
      writeFileSync(detailPath, '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(value));
      return 'held';
    },
  });
} else {
  throw new Error(`unknown storage worker mode: ${mode}`);
}
