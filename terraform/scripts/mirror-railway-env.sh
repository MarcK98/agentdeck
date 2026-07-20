#!/usr/bin/env bash
# Mirror the Railway relay's secrets into this AWS deployment so the AWS relay is
# a byte-identical drop-in: same RELAY_DAEMON_KEY/DEV_TOKEN (so the daemon needs
# no change beyond its URL) and same AUTH_JWT_SECRET/AUTH_USERS (so already-issued
# phone JWTs keep working and email/password login behaves the same).
#
# Writes terraform/secrets.auto.tfvars.json (gitignored, 0600). Never prints
# secret values. Usage: mirror-railway-env.sh [relay_hostname]
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

HOSTNAME_ARG="${1:-}"
[ -f .railway-token ] || { echo "no .railway-token"; exit 1; }
export RAILWAY_TOKEN="$(grep -oE 'RAILWAY_TOKEN=.*' .railway-token | cut -d= -f2-)"

RV="$(cd packages/relay && railway variables --kv)"
get() { printf '%s\n' "$RV" | grep -E "^$1=" | head -1 | cut -d= -f2- || true; }
R_DAEMON="$(get RELAY_DAEMON_KEY)"
R_DEV="$(get RELAY_DEV_TOKEN)"
R_JWT="$(get AUTH_JWT_SECRET)"
R_USERS="$(get AUTH_USERS)"
R_TTL="$(get AUTH_TOKEN_TTL)"

# Sanity: the daemon presents .env's key — it must equal what AWS will accept.
E_DAEMON="$(grep -E '^SPAWN_RELAY_DAEMON_KEY=' .env | cut -d= -f2- || true)"
E_DEV="$(grep -E '^SPAWN_RELAY_ACCESS_TOKEN=' .env | cut -d= -f2- || true)"
[ -n "$R_DAEMON" ] && [ "$R_DAEMON" = "$E_DAEMON" ] && echo "daemon key: Railway == .env  ✓" || echo "WARN daemon key: Railway != .env (daemon may need .env update)"
[ -n "$R_DEV" ] && [ "$R_DEV" = "$E_DEV" ] && echo "dev token: Railway == .env  ✓" || echo "note dev token: Railway != .env (phone uses email/password anyway)"
[ -n "$R_JWT" ] && echo "AUTH_JWT_SECRET: mirrored ✓" || echo "WARN AUTH_JWT_SECRET empty on Railway"
[ -n "$R_USERS" ] && echo "AUTH_USERS: mirrored ✓" || echo "WARN AUTH_USERS empty on Railway"

# Preserve the existing VPS control token from terraform.tfvars (HCL).
VPS="$(grep -E '^[[:space:]]*vps_control_token' terraform/terraform.tfvars 2>/dev/null | sed -E 's/.*=[[:space:]]*//; s/^"//; s/"$//' || true)"
[ -n "$VPS" ] || { echo "ERROR: couldn't read vps_control_token from terraform.tfvars"; exit 1; }

jq -n \
  --arg dk "$R_DAEMON" --arg dv "$R_DEV" --arg jwt "$R_JWT" \
  --arg users "$R_USERS" --arg ttl "$R_TTL" --arg vps "$VPS" --arg host "$HOSTNAME_ARG" \
  '{relay_daemon_key:$dk, relay_dev_token:$dv, auth_jwt_secret:$jwt, auth_users:$users, auth_token_ttl:$ttl, vps_control_token:$vps, relay_hostname:$host}' \
  > terraform/secrets.auto.tfvars.json
chmod 600 terraform/secrets.auto.tfvars.json

# terraform.tfvars is now fully superseded by the JSON — drop it to keep one source.
rm -f terraform/terraform.tfvars
echo "wrote terraform/secrets.auto.tfvars.json (relay_hostname='${HOSTNAME_ARG:-<empty>}')"
