import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SETUP_TOKEN = 'playwright-setup-token-0000000001';
const CONTROL_URL = 'http://127.0.0.1:4174';
const NOTE_TITLE = 'Browser persistence';
const EDITED_TITLE = 'Browser persistence edited';
const EDITED_CONTENT = 'This edit must survive a full reload.';
const IMAGE_NAME = 'playwright-pixel.png';
const KEEP_IMPORT_TITLE = 'Google Keep image import';
const KEEP_IMPORT_IMAGE = 'keep-referenced-pixel.png';
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6qAAAAABJRU5ErkJggg==',
  'base64',
);

interface RecoveryKitV2Fixture {
  version: 2;
  instanceId: string;
  recoveryKey: string;
  masterKeyEnvelope: {
    version: 1;
    algorithm: 'AES-GCM';
    keyId: string;
    iv: string;
    ciphertext: string;
  };
}

async function createLegacyRecoveryKit(kit: RecoveryKitV2Fixture): Promise<string> {
  const recoveryKeyBytes = Buffer.from(kit.recoveryKey, 'base64');
  const recoveryKey = await crypto.subtle.importKey(
    'raw',
    recoveryKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const masterKey = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(kit.masterKeyEnvelope.iv, 'base64'),
      additionalData: new TextEncoder().encode(
        `unkeep:1:recovery-master-key:${kit.instanceId}:${kit.masterKeyEnvelope.keyId}`,
      ),
      tagLength: 128,
    },
    recoveryKey,
    Buffer.from(kit.masterKeyEnvelope.ciphertext, 'base64'),
  );
  const legacyRecoveryKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const legacyRecoveryKey = await crypto.subtle.importKey(
    'raw',
    legacyRecoveryKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyId = 'legacy-e2e-recovery';
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(`unkeep:1:recovery-master-key:${keyId}`),
      tagLength: 128,
    },
    legacyRecoveryKey,
    masterKey,
  );
  return JSON.stringify({
    version: 1,
    recoveryKey: Buffer.from(legacyRecoveryKeyBytes).toString('base64'),
    masterKeyEnvelope: {
      version: 1,
      algorithm: 'AES-GCM',
      keyId,
      iv: Buffer.from(iv).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    },
  });
}

test.describe.serial('UnKeep browser vault', () => {
  let context: BrowserContext;
  let page: Page;
  let recoveryKit: RecoveryKitV2Fixture;

  test.beforeAll(async ({ browser, baseURL }) => {
    context = await browser.newContext({
      baseURL,
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  async function relayStatus(): Promise<{ initialized: boolean; instanceId: string }> {
    const response = await page.request.get('/api/v1/status');
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ initialized: boolean }>;
  }

  test('keeps the relay unclaimed while the first device downloads and confirms its recovery kit', async () => {
    await page.goto('/');
    await expect(page.getByLabel('Sync server')).toHaveValue('http://127.0.0.1:4173');
    await expect.poll(async () => (await relayStatus()).initialized).toBe(false);

    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel('Setup token').fill(SETUP_TOKEN);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Save your recovery kit' })).toBeVisible();
    const initialize = page.getByRole('button', { name: 'Initialize and open UnKeep' });
    await expect(initialize).toBeDisabled();
    await expect.poll(async () => (await relayStatus()).initialized).toBe(false);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recovery kit' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('unkeep-recovery-kit.json');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    recoveryKit = JSON.parse(
      await readFile(downloadPath as string, 'utf8'),
    ) as RecoveryKitV2Fixture;
    expect(recoveryKit).toMatchObject({
      version: 2,
      instanceId: (await relayStatus()).instanceId,
    });
    expect(recoveryKit.recoveryKey).toEqual(expect.any(String));
    expect(recoveryKit.masterKeyEnvelope).toEqual(expect.any(Object));

    await expect(page.getByRole('checkbox', { name: 'I saved it somewhere safe' })).toBeChecked();
    await expect(initialize).toBeEnabled();
    await expect.poll(async () => (await relayStatus()).initialized).toBe(false);

    await initialize.click();
    await expect(page.getByRole('button', { name: 'Create a new note' })).toBeVisible();
    await expect.poll(async () => (await relayStatus()).initialized).toBe(true);
  });

  test('warns before associating a legacy kit and cancellation persists no access', async ({ browser }) => {
    const legacyKit = await createLegacyRecoveryKit(recoveryKit);
    const recoveryContext = await browser.newContext({ baseURL: page.url() });
    const recoveryPage = await recoveryContext.newPage();
    try {
      await recoveryPage.goto('/');
      await recoveryPage.getByRole('button', { name: 'Connect' }).click();
      await recoveryPage.locator('input[type="file"]').setInputFiles({
        name: 'legacy-recovery-kit.json',
        mimeType: 'application/json',
        buffer: Buffer.from(legacyKit),
      });
      await expect(recoveryPage.getByRole('heading', { name: 'Legacy recovery kit' })).toBeVisible();
      await recoveryPage.getByRole('button', { name: 'Cancel' }).click();
      await recoveryPage.reload();
      await expect(recoveryPage.getByRole('button', { name: 'Connect' })).toBeVisible();

      await recoveryPage.getByRole('button', { name: 'Connect' }).click();
      await recoveryPage.locator('input[type="file"]').setInputFiles({
        name: 'legacy-recovery-kit.json',
        mimeType: 'application/json',
        buffer: Buffer.from(legacyKit),
      });
      await recoveryPage.getByRole('button', { name: 'Associate kit with this relay' }).click();
      await recoveryPage.getByLabel('Operator recovery token').fill('playwright-recovery-token-00000001');
      await recoveryPage.getByRole('button', { name: 'Recover access' }).click();
      await expect(recoveryPage.getByRole('button', { name: 'Create a new note' })).toBeVisible();
    } finally {
      await recoveryContext.close();
    }
  });

  test('persists a created and edited note across a full reload', async () => {
    await page.getByRole('button', { name: 'Create a new note' }).click();
    await page.getByLabel('Note title').fill(NOTE_TITLE);
    await page.getByLabel('Note content').fill('Created through the public browser interface.');
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: `Edit note: ${NOTE_TITLE}` }).click();
    const editor = page.getByRole('dialog', { name: 'Edit note' });
    await editor.getByLabel('Note title').fill(EDITED_TITLE);
    await editor.getByLabel('Note content').fill(EDITED_CONTENT);
    await editor.getByRole('button', { name: 'Close' }).click();

    // The editor deliberately debounces writes for 500 ms.
    await page.waitForTimeout(650);
    await expect(page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` })).toBeVisible();
    await expect(page.getByText(EDITED_CONTENT, { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Create a new note' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` })).toBeVisible();
    await expect(page.getByText(EDITED_CONTENT, { exact: true })).toBeVisible();
  });

  test('keeps an attached image visible after reload', async () => {
    await page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` }).click();
    const editor = page.getByRole('dialog', { name: 'Edit note' });
    await editor.getByLabel('Add attachment').setInputFiles({
      name: IMAGE_NAME,
      mimeType: 'image/png',
      buffer: IMAGE_BYTES,
    });

    const editorImage = editor.getByRole('img', { name: IMAGE_NAME });
    await expect(editorImage).toBeVisible();
    await expect.poll(() => editorImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await editor.getByRole('button', { name: 'Close' }).click();

    await expect(page.getByRole('img', { name: IMAGE_NAME })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` })).toBeVisible();
    const reloadedImage = page.getByRole('img', { name: IMAGE_NAME });
    await expect(reloadedImage).toBeVisible();
    await expect.poll(() => reloadedImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  });

  test('imports a Google Keep note with its referenced image and reloads the decoded bytes', async () => {
    await page.getByRole('button', { name: 'Import from Keep' }).click();
    const importer = page.getByRole('dialog', { name: 'Import notes' });
    await importer.locator('#keep-import-files').setInputFiles([
      {
        name: 'keep-image-note.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
          title: KEEP_IMPORT_TITLE,
          textContent: 'Imported with referenced media.',
          attachments: [{ filePath: KEEP_IMPORT_IMAGE, mimetype: 'image/png' }],
        })),
      },
      {
        name: KEEP_IMPORT_IMAGE,
        mimeType: 'image/png',
        buffer: IMAGE_BYTES,
      },
    ]);
    await expect(importer.getByText('Ready to import from Google Keep.')).toBeVisible();
    await importer.getByRole('button', { name: 'Import 1 notes' }).click();
    await expect(importer.getByText('Imported 1 notes!')).toBeVisible();
    await importer.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByRole('button', { name: `Edit note: ${KEEP_IMPORT_TITLE}` })).toBeVisible();
    const importedImage = page.getByRole('img', { name: KEEP_IMPORT_IMAGE });
    await expect(importedImage).toBeVisible();
    await expect.poll(() => importedImage.evaluate(
      (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
    )).toBe(true);

    await page.reload();
    await expect(page.getByRole('button', { name: `Edit note: ${KEEP_IMPORT_TITLE}` })).toBeVisible();
    const reloadedImage = page.getByRole('img', { name: KEEP_IMPORT_IMAGE });
    await expect(reloadedImage).toBeVisible();
    await expect.poll(() => reloadedImage.evaluate(
      (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
    )).toBe(true);
  });

  test('cold-starts the installed app and local vault while the relay is unavailable', async ({ request, baseURL }) => {
    await expect.poll(async () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    }), { timeout: 10_000 }).toBe(true);

    const pauseResponse = await request.post(`${CONTROL_URL}/pause`);
    expect(pauseResponse.ok()).toBe(true);
    await page.close();
    await context.setOffline(true);
    try {
      page = await context.newPage();
      const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
      expect(response?.fromServiceWorker()).toBe(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await expect.poll(() => page.evaluate(async () => {
        try {
          await fetch('/api/v1/status');
          return false;
        } catch {
          return true;
        }
      })).toBe(true);
      await expect(page.getByRole('button', { name: 'Create a new note' })).toBeVisible();
      await expect(page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` })).toBeVisible();
      await expect(page.getByRole('img', { name: IMAGE_NAME })).toBeVisible();
    } finally {
      await context.setOffline(false);
      const resumeResponse = await request.post(`${CONTROL_URL}/resume`);
      expect(resumeResponse.ok()).toBe(true);
      await expect.poll(async () => {
        try {
          return (await request.get(`${baseURL}/api/v1/status`)).ok();
        } catch {
          return false;
        }
      }).toBe(true);
    }

    await page.reload();
    await expect(page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` })).toBeVisible();
  });

  test('durably saves a received Quick Send snapshot', async () => {
    await page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` }).click();
    const editor = page.getByRole('dialog', { name: 'Edit note' });
    await editor.getByRole('button', {
      name: 'Quick Send — copy unencrypted snapshot link',
    }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/recv#');
    const quickSendUrl = await page.evaluate(() => navigator.clipboard.readText());
    await editor.getByRole('button', { name: 'Close' }).click();

    await page.goto(quickSendUrl);
    await expect(page.getByRole('heading', { name: EDITED_TITLE })).toBeVisible();
    await expect(page.getByText(EDITED_CONTENT, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save to UnKeep' }).click();
    await expect(page.getByText('Saved!', { exact: true })).toBeVisible();

    await page.goto('/');
    const savedCards = page.getByRole('button', { name: `Edit note: ${EDITED_TITLE}` });
    await expect(savedCards).toHaveCount(2);
    await page.reload();
    await expect(savedCards).toHaveCount(2);
  });
});
