export default async function globalTeardown() {
  try {
    await fetch('http://127.0.0.1:4174/shutdown', { method: 'POST' });
  } catch {
    // Preserve the original Playwright failure if the harness never started
    // or already exited unexpectedly.
  }
}
