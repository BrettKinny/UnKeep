<script lang="ts">
  // Web Crypto, randomUUID, and service workers only exist in secure contexts,
  // so a plain-HTTP LAN address cannot open the vault at all.
  const origin = window.location.origin;
  const guide = 'https://github.com/BrettKinny/UnKeep/blob/main/docs/self-hosting.md#serve-it-over-https';
</script>

<main class="grid min-h-dvh place-items-center bg-surface-dim p-4"><section class="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-lg" aria-labelledby="insecure-context-title">
  <div class="mb-5 flex items-center gap-3"><img src="/icon.svg" alt="" class="h-12 w-12"/><div><h1 class="text-2xl font-semibold">UnKeep</h1><p class="text-sm text-on-surface-muted">Your notes. Your storage.</p></div></div>
  <div class="grid gap-3 text-sm">
    <h2 id="insecure-context-title" class="text-base font-semibold">UnKeep needs HTTPS</h2>
    <p class="text-on-surface-muted">This page was opened at <code class="break-all" dir="ltr">{origin}</code> over plain HTTP. Browsers only allow the encryption UnKeep relies on over HTTPS, so your vault cannot be opened here.</p>
    <p class="text-on-surface-muted">Put the server behind HTTPS and open that address instead, for example:</p>
    <ul class="list-disc pl-5 text-on-surface-muted">
      <li>Tailscale Serve on the host</li>
      <li>A reverse proxy such as Nginx Proxy Manager, SWAG, or Caddy</li>
      <li>Cloudflare Tunnel</li>
    </ul>
    <a class="rounded-lg bg-primary px-4 py-2 text-center text-on-primary" href={guide} target="_blank" rel="noopener noreferrer">Read the HTTPS setup guide</a>
  </div>
</section></main>
