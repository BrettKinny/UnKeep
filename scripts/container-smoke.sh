#!/usr/bin/env bash

set -euo pipefail

image="${1:?usage: container-smoke.sh IMAGE}"
container="unkeep-smoke-${RANDOM}"

cleanup() {
  docker logs "$container" 2>/dev/null || true
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --entrypoint sh "$image" -c \
  'test "$(id -u)" = 1000 &&
   test "$(stat -c %a:%u:%g /data)" = 700:1000:1000 &&
   test "$(stat -c %a:%u:%g /home/node/.config)" = 700:1000:1000 &&
   test "$(stat -c %a:%u:%g /home/node/.config/unkeep)" = 700:1000:1000 &&
   test -s /app/THIRD_PARTY_NOTICES.md &&
   test -s /app/web/THIRD_PARTY_NOTICES.md &&
   test -s /usr/local/LICENSE &&
   ! command -v npm &&
   ! command -v npx &&
   ! command -v pnpm &&
   ! command -v pnpx &&
   ! command -v yarn &&
   ! command -v corepack'

if [[ -n "${EXPECTED_VERSION:-}" ]]; then
  test "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')" = "$EXPECTED_VERSION"
  docker run --rm --entrypoint grep "$image" \
    -Fq "$EXPECTED_VERSION-$EXPECTED_REVISION" /app/web/service-worker.js
fi

if [[ -n "${EXPECTED_REVISION:-}" ]]; then
  test "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$EXPECTED_REVISION"
fi

docker run --rm \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=volume,destination=/home/node/.config/unkeep \
  --entrypoint node \
  "$image" \
  --input-type=module \
  --eval '
    import { stat } from "node:fs/promises";
    import { JsonFileClientStorage } from "/app/cli/dist/storage.js";
    const path = "/home/node/.config/unkeep/config.json";
    const storage = new JsonFileClientStorage(path);
    await storage.set("volumeProbe", "ok");
    if (await storage.get("volumeProbe") !== "ok") throw new Error("config volume round trip failed");
    const directoryMode = (await stat("/home/node/.config/unkeep")).mode & 0o777;
    const fileMode = (await stat(path)).mode & 0o777;
    if (directoryMode !== 0o700 || fileMode !== 0o600) throw new Error("unsafe CLI config permissions");
  '

docker run --name "$container" --detach \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env UNKEEP_SETUP_TOKEN=container-smoke-setup-token-0000001 \
  --env UNKEEP_RECOVERY_TOKEN=container-smoke-recovery-token-0001 \
  "$image"

for _ in $(seq 1 20); do
  if docker exec "$container" wget -qO- http://127.0.0.1:3000/api/v1/status; then
    exit 0
  fi
  sleep 1
done

exit 1
