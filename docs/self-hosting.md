# Self-hosting UnKeep

UnKeep ships as one container containing the PWA and its encrypted sync server. The server stores opaque AES-GCM envelopes in `/data/unkeep.sqlite`; it never receives the vault key or plaintext notes.

## Start it

Create a long, random one-time token and start the container:

```sh
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose up --build -d
```

Put port 3000 behind an HTTPS reverse proxy, Tailscale Serve, or Cloudflare Tunnel. Browsers block the cryptography and PWA features UnKeep needs on insecure non-local origins.

Open the HTTPS address. On the first device, enter the same setup token once. UnKeep exchanges it for a revocable device credential; the setup token cannot be used again. Save the recovery kit when prompted.

To add another device, open the server URL there, choose **Pair with another device**, then enter its eight-character code in the device menu on an already unlocked device.

The hosted PWA can also connect to this server. Set `UNKEEP_ALLOWED_ORIGIN` to that PWA's origin if you want to restrict browser access; the default `*` is safe for the bearer-token API but less restrictive.

## Backups

Back up the whole `/data` volume. It contains ciphertext and device records. Also keep the downloaded recovery kit somewhere separate: a server backup cannot decrypt your notes, and losing every paired device plus the recovery kit is permanent data loss.

## Unraid settings

- Web UI / container port: `3000`
- Persistent path: `/data`
- Required variable: `UNKEEP_SETUP_TOKEN`
- Reverse proxy: HTTPS is required
