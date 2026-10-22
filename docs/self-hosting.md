# Self-hosting UnKeep

UnKeep runs as one container that serves the web app and its sync relay on
port 3000 and keeps an SQLite database in `/data`. The relay only stores
encrypted notes; your vault key never leaves your devices.

You need:

- Docker (or Unraid),
- a way to serve it over **HTTPS** (Tailscale Serve, a reverse proxy, or
  Cloudflare Tunnel),
- two random tokens, which the steps below generate.

Every setting is listed in the [configuration reference](configuration.md).

## Install with Docker Compose

These commands download the release's Compose file, check it against the
release checksums, and pin the exact image the release published. A registry
tag that moves later can't change what you run.

```sh
set -eu
mkdir unkeep && cd unkeep
release_url=https://github.com/BrettKinny/UnKeep/releases/download/v0.2.1
curl -fsSLO "$release_url/compose.release.yaml"
curl -fsSLO "$release_url/unkeep-0.2.1-image-digest.txt"
curl -fsSLO "$release_url/SHA256SUMS"
grep -E \
  '^[0-9a-f]{64}  (compose\.release\.yaml|unkeep-0\.2\.1-image-digest\.txt)$' \
  SHA256SUMS > RELEASE_SHA256SUMS
test "$(wc -l < RELEASE_SHA256SUMS)" -eq 2
sha256sum --check --strict RELEASE_SHA256SUMS
rm RELEASE_SHA256SUMS
release_digest="$(
  sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' \
    unkeep-0.2.1-image-digest.txt
)"
printf '%s\n' "$release_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
mv compose.release.yaml compose.yaml
install -d -m 700 data
# The published container runs as the non-root node user (UID/GID 1000).
sudo chown 1000:1000 data
install -m 600 /dev/null .env
{
  printf 'UNKEEP_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_RECOVERY_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_IMAGE=ghcr.io/brettkinny/unkeep@%s\n' "$release_digest"
} > .env
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

The relay is now listening on `127.0.0.1:3000`. Next,
[serve it over HTTPS](#serve-it-over-https).

`.env` holds both tokens and the pinned image, with mode `0600`. Every Compose
command in this guide passes `--env-file .env` because Compose needs the
tokens even for one-off commands. Never commit `.env`, and don't keep it
together with both your recovery kit and your backups.

<details>
<summary>Optional: verify the release with the GitHub CLI</summary>

Run these after downloading the files and before `mv compose.release.yaml`.
They confirm the release is immutable and the files match its attestations.

```sh
gh release verify v0.2.1 --repo BrettKinny/UnKeep
gh release verify-asset v0.2.1 compose.release.yaml --repo BrettKinny/UnKeep
gh release verify-asset v0.2.1 unkeep-0.2.1-image-digest.txt --repo BrettKinny/UnKeep
gh release verify-asset v0.2.1 SHA256SUMS --repo BrettKinny/UnKeep
```

</details>

<details>
<summary>Build from source instead</summary>

```sh
git clone --branch v0.2.1 https://github.com/BrettKinny/UnKeep.git
cd UnKeep
install -d -m 700 data
sudo chown 1000:1000 data
install -m 600 /dev/null .env
{
  printf 'UNKEEP_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_RECOVERY_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_BUILD_VERSION=0.2.1\n'
  printf 'UNKEEP_BUILD_REVISION=%s\n' "$(git rev-parse HEAD)"
} > .env
docker compose --env-file .env up --build -d
```

</details>

## Unraid settings

Install **UnKeep** from Community Applications and fill in:

- **Setup token** and **Recovery token**: two *different* random values, for
  example from `openssl rand -hex 32`.
- **Data**: `/mnt/user/appdata/unkeep` by default. It needs no preparation.

Then [serve it over HTTPS](#serve-it-over-https). The **WebUI** button opens
plain HTTP, which shows an "UnKeep needs HTTPS" page instead of your vault.
With Tailscale on the Unraid host, use a free port because the Unraid UI may
already own 443:

```sh
tailscale serve --bg --https=3443 http://127.0.0.1:3000
```

Prefer Tailscale Serve on the host over a Tailscale sidecar container, which
has to re-authenticate after restarts.

**How permissions work:** the template starts the container as root with only
the `CHOWN`, `SETUID`, and `SETGID` capabilities. The relay gives `/data` to
`PUID:PGID` (`99:100`, Unraid's `nobody:users`), then permanently switches to
that user before opening the database, which drops every capability. This
also takes over a folder that an earlier container owned as UID 1000. If a
capability is missing, the relay stops with a message naming it.

To create the container by hand, use:

| Setting | Value |
| --- | --- |
| Image | `ghcr.io/brettkinny/unkeep:latest`, or `:0.2` to stay on one minor version |
| Port | `3000` |
| Path | `/data` → `/mnt/user/appdata/unkeep` |
| Variables | `PUID=99`, `PGID=100`, `UNKEEP_SETUP_TOKEN`, `UNKEEP_RECOVERY_TOKEN` |
| Extra Parameters | `--user 0:0 --read-only --tmpfs /tmp:size=16m,mode=1777 --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges` |

Don't add `--init`. The relay handles shutdown itself and runs as PID 1, so
nothing in the container stays root.

Before applying an update, stop the container and back up the appdata folder.
Database upgrades are one-way.

## Serve it over HTTPS

Browsers only allow the encryption and app features UnKeep needs on HTTPS or
`localhost`. Compose publishes port 3000 on `127.0.0.1` only, so put an HTTPS
front end on the same host:

- **Tailscale Serve** (private to your tailnet):

  ```sh
  tailscale serve --bg --https=443 http://127.0.0.1:3000
  ```

  Check it with `tailscale serve status`; remove it with
  `tailscale serve --https=443 off`. Use another `--https=<port>` if 443 is
  taken.
- **A reverse proxy** such as Caddy, Nginx Proxy Manager, SWAG, or Traefik.
- **Cloudflare Tunnel.**

Keep the security headers the relay sends (Content Security Policy, frame
denial, and others) when proxying. The relay doesn't send HSTS; add it at your
proxy once you're sure the hostname is HTTPS-only. Exposing port 3000
directly on a LAN means credentials cross that network unencrypted.

If your proxy *replaces* `X-Forwarded-For`, set `UNKEEP_TRUST_PROXY=1` so rate
limits see real client addresses.

## Set up your devices

Open the HTTPS address and enter the **setup token**. UnKeep creates your
encryption key in the browser and makes you save a **recovery kit** before it
initializes the server. The setup token works only once.

To add a device, open the same address there and choose **Pair with another
device**. Enter the eight-character code in the device menu of a device that's
already unlocked. Both screens show a four-group fingerprint: compare **every
character** and cancel if anything differs.

The device menu lists your devices and agent credentials. Revoking a device
also revokes every device it paired and every agent credential minted under
it. Revoking stops future access but can't erase notes or keys already on that
device.

### If a device is lost or compromised

Revoke it from the device menu on another device. If you can't trust the
device list, revoke **everything** with an active device credential, then
restore access with your recovery kit:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Device $UNKEEP_DEVICE_CREDENTIAL" \
  "${UNKEEP_ENDPOINT%/}/api/v1/devices"
```

This revokes every device (including the one calling it) and every agent
credential, and cancels pending pairings. Make sure you have the recovery kit
and recovery token first. It doesn't change the vault key, so anything already
copied stays readable to whoever has it.

## Recover access after losing every device

You need both:

- the **recovery kit**, which restores your encryption key in the browser, and
- the **recovery token**, which lets the relay create a new device.

Open the server on the new device, choose **Restore recovery kit**, select the
kit, and enter the recovery token. The kit is decrypted locally; only the
token reaches the server.

Recovery kits are tied to the relay that created them. Older (v1) kits aren't,
so UnKeep asks you to confirm before using one; download a new kit afterwards.

## Backups

Back up the whole `data` folder while the relay is stopped. Copying the
database from a running relay can miss recent writes.

```sh
docker compose --env-file .env stop unkeep
tar --numeric-owner -czf "unkeep-data-$(date +%F).tgz" data/
docker compose --env-file .env start unkeep
```

A backup is encrypted and useless without your recovery kit, and the kit can't
restore notes without a backup. Store the backup, the recovery kit, and the
recovery token in separate places.

Test a backup before you rely on it:

```sh
docker compose --env-file .env down
mv data "data.before-restore-$(date +%s)"
install -d -m 700 data
sudo chown 1000:1000 data
tar --numeric-owner -xzf unkeep-data-YYYY-MM-DD.tgz
docker compose --env-file .env run --rm --entrypoint node unkeep server/check-database.mjs
docker compose --env-file .env up -d
```

Then open the app, check some notes and attachments, and pair and revoke a
temporary device. Keep the old folder until all of that works.

## Upgrade

Database upgrades are one-way, so rolling back means restoring both the old
image and the backup taken before upgrading.

1. Take a stopped backup as above.
2. Set `UNKEEP_IMAGE` in `.env` to the new release's digest, from its
   `unkeep-X.Y.Z-image-digest.txt`.
3. Check the database with the new image before starting it:

   ```sh
   docker compose --env-file .env pull
   docker compose --env-file .env run --rm --entrypoint node unkeep server/check-database.mjs
   docker compose --env-file .env up -d
   ```

4. Reload installed web apps and update any CLIs.

Upgrading a vault created before 0.2.1? Read
[upgrading from previews](upgrading.md) first.

## Terminal and agent access

The image includes the `unkeep` CLI. Run it as the separate `unkeep-cli`
service so its keys never live in the relay container:

```sh
docker compose --env-file .env run --rm --no-deps unkeep-cli login --endpoint http://unkeep:3000
docker compose --env-file .env run --rm --no-deps unkeep-cli list
docker compose --env-file .env run --rm --no-deps unkeep-cli provision --name "my agent"
```

`--no-deps` assumes the relay is already running. The `unkeep-cli-config`
volume holds the CLI's notes, vault key, and credential in plaintext, so
protect it like a browser profile. Don't run the CLI with
`docker compose exec unkeep`.

To move files, mount a dedicated folder: read-only to upload, writable to
download. Never mount your home directory or a whole repository.

```sh
install -d -m 700 transfer
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:ro" --workdir /transfer \
  unkeep-cli clip ./report.pdf
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:rw" --workdir /transfer \
  unkeep-cli paste
```

Downloaded files are owned by UID 1000. `paste` won't overwrite a file unless
you pass `--force`. See the [agent scratchpad guide](agent-scratchpad.md) for
everything else.

For monitoring, `GET /api/v1/status` needs no credentials:

```sh
curl https://notes.example.com/api/v1/status
```

## Link previews

Set `UNKEEP_LINK_PREVIEWS=1` to show a title and thumbnail under links in
notes, like Google Keep. It's off by default because the relay then sees those
URLs in plaintext and fetches the pages itself, and thumbnails load directly
from the linked site.

Only your devices can request previews; agent credentials can't. The relay
only fetches public addresses on ports 80 and 443, so links to LAN pages (a
router or NAS) never get previews. Nothing fetched is stored on the server;
each browser keeps its own cache. The relay needs outbound internet access.

## Sharing into UnKeep

On Android, the installed app receives shares through its service worker and
keeps them on the device. If that worker isn't running, the shared text
reaches your proxy and relay before being rejected (it's never stored).
The [iOS shortcut](ios-share-shortcut.md) doesn't have this exposure.
