# Self-hosting UnKeep

UnKeep ships as one container containing the PWA and its encrypted sync server. The server stores opaque AES-GCM envelopes in `/data/unkeep.sqlite`; it never receives the vault key or plaintext notes.

## Start it

Create separate long, random setup and operator-recovery tokens, then start the container:

```sh
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
export UNKEEP_RECOVERY_TOKEN="$(openssl rand -base64 32)"
docker compose up --build -d
```

`UNKEEP_SETUP_TOKEN` can initialize a new server only once. `UNKEEP_RECOVERY_TOKEN` can later mint a replacement device credential if every authorized device is lost. Existing installations that omit `UNKEEP_RECOVERY_TOKEN` fall back to using `UNKEEP_SETUP_TOKEN` for recovery, so do not discard the setup token unless a distinct recovery token is configured.

Put port 3000 behind an HTTPS reverse proxy, Tailscale Serve, or Cloudflare Tunnel. Browsers block the cryptography and PWA features UnKeep needs on insecure non-local origins.

If Tailscale is installed on the Docker host, expose UnKeep through that existing node instead of running a second ephemeral Tailscale container:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

This publishes UnKeep at the host's Tailnet-only HTTPS name. Check the active route with `tailscale serve status` and remove it with `tailscale serve --https=443 off`. If port 443 already serves another application, choose a free HTTPS port with `--https=<port>`.

Open the HTTPS address. On the first device, enter the setup token. UnKeep creates the encryption key locally and requires you to save its recovery kit before it initializes the server and exchanges the setup token for a revocable device credential.

To add another device, open the server URL there, choose **Pair with another device**, then enter its eight-character code in the device menu on an already unlocked device.

The device menu lists trusted devices. You can revoke any device other than the one currently in use. Revocation blocks future relay access but cannot erase notes or keys already stored on that device.

## Recover access after losing every device

Recovery requires both secrets with different jobs:

- The recovery kit restores the vault encryption key in the browser.
- The operator recovery token authorizes the relay to mint a new device credential.

New recovery kits use authenticated format v2 and are bound to the relay instance that created them. Editing the stored instance ID or selecting the kit for a different relay makes decryption fail before local keys, sessions, notes, or sync state are opened.

Legacy v1 kits do not contain a relay identity. On a fresh browser, UnKeep shows a dedicated warning and requires confirmation before associating one with the selected relay. A browser that retains local data for that relay also retains a non-secret vault-key fingerprint when access is cleared; a legacy kit with a different key is rejected before vault initialization or network writes. After a successful legacy recovery, download a new recovery kit so future recovery uses authenticated v2.

The operator token proves permission to mint relay access. It does **not** prove that an unbound v1 kit contains the correct encryption key, which is why fresh-browser legacy association requires an explicit trust decision.

Open the server from a replacement device, choose **Restore recovery kit**, select the kit, and enter `UNKEEP_RECOVERY_TOKEN` when prompted. The kit is decrypted locally; neither it nor the vault key is sent to the server. The server receives only the operator token and the replacement device identity.

Protect the operator token like an administrative password. Someone with it can mint relay access and modify or delete ciphertext even without the recovery kit. To rotate it, set a new `UNKEEP_RECOVERY_TOKEN` and recreate the container:

```sh
export UNKEEP_RECOVERY_TOKEN="$(openssl rand -base64 32)"
docker compose up -d --force-recreate
```

Rotation does not revoke existing device credentials. Revoke lost devices separately from the device menu.

The hosted PWA can also connect to this server. Set `UNKEEP_ALLOWED_ORIGIN` to that PWA's origin if you want to restrict browser access; the default `*` is safe for the bearer-token API but less restrictive.

## Terminal access

The image bundles the `unkeep` CLI, so the container doubles as a zero-install terminal client:

```sh
docker compose exec unkeep unkeep --help
docker compose exec -it unkeep unkeep login --endpoint http://127.0.0.1:3000
docker compose exec unkeep unkeep list
```

Note that `login` stores the vault key in the container filesystem (lost when the container is recreated, and visible to anyone who can exec into it). For durable or agent access, prefer minting a service credential bundle with `unkeep provision` and exporting its `UNKEEP_*` variables wherever the CLI runs — see the [agent scratchpad guide](agent-scratchpad.md).

Use the unauthenticated status endpoint to monitor the relay from the container host or another machine:

```sh
curl https://notes.example.com/api/v1/status
```

Other `/api/v1` request and response shapes are internal wire details. Use the CLI or `@unkeep/client` for integrations instead of scripting raw ciphertext records.

## Backups

Back up the whole `/data` volume. It contains ciphertext and device records. Keep the downloaded recovery kit and operator recovery token in separate secure locations: a server backup cannot decrypt your notes, and the recovery kit alone cannot authorize a replacement device with the relay.

## Unraid settings

- Web UI / container port: `3000`
- Persistent path: `/data`
- Required variable: `UNKEEP_SETUP_TOKEN`
- Recommended variable: `UNKEEP_RECOVERY_TOKEN` (falls back to `UNKEEP_SETUP_TOKEN` when omitted)
- Optional variable: `UNKEEP_MAX_ATTACHMENT_SIZE` (maximum plaintext attachment size in bytes; defaults to 25 MiB)
- Reverse proxy: HTTPS is required
- Tailscale: prefer Tailscale Serve on the Unraid host; avoid an ephemeral sidecar that must reauthenticate after every restart. The Unraid UI may already own port 443, so use a free HTTPS port such as 3443.
