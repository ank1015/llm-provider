#!/bin/sh
set -eu

: "${GATEWAY_IMAGE:?GATEWAY_IMAGE is required}"
: "${GATEWAY_HOST:?GATEWAY_HOST is required}"
: "${GCP_PROJECT_NUMBER:?GCP_PROJECT_NUMBER is required}"

cd /opt/llm-providers-gateway
umask 077
chmod 0644 prod-ca-2021.crt

metadata_header='Metadata-Flavor: Google'
token_json="$(curl -fsS -H "$metadata_header" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)"
access_token="$(printf '%s' "$token_json" | jq -r .access_token)"

read_secret() {
  curl -fsS \
    -H "Authorization: Bearer $access_token" \
    "https://secretmanager.googleapis.com/v1/projects/$GCP_PROJECT_NUMBER/secrets/$1/versions/latest:access" \
    | jq -r .payload.data \
    | base64 -d
}

database_url="$(read_secret llm-providers-database-url)"
admin_api_key="$(read_secret llm-providers-admin-api-key)"
encryption_key="$(read_secret llm-providers-encryption-key)"

{
  printf 'GATEWAY_IMAGE=%s\n' "$GATEWAY_IMAGE"
  printf 'GATEWAY_HOST=%s\n' "$GATEWAY_HOST"
  printf 'DATABASE_URL=%s\n' "$database_url"
  printf 'ADMIN_API_KEY=%s\n' "$admin_api_key"
  printf 'ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'PORT=3000\n'
  printf 'REQUEST_RETENTION_DAYS=7\n'
  printf 'WORKER_CONCURRENCY=12\n'
  printf 'PROVIDER_ALLOWED_ORIGINS=\n'
  printf 'WEBHOOK_ALLOWED_ORIGINS=https://*.acentric.dev\n'
} > .env.new

chmod 0600 .env.new
mv .env.new .env

registry=https://asia-south1-docker.pkg.dev
printf '%s' "$access_token" \
  | docker login -u oauth2accesstoken --password-stdin "$registry"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT

docker-compose -f compose.production.yml pull
docker-compose -f compose.production.yml run --rm migrate
docker-compose -f compose.production.yml up -d --remove-orphans api caddy

attempt=0
until curl -fsS "https://$GATEWAY_HOST/readyz" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "The updated API did not become ready." >&2
    exit 1
  fi
  sleep 2
done

docker-compose -f compose.production.yml up -d --remove-orphans worker
docker-compose -f compose.production.yml rm -f migrate
