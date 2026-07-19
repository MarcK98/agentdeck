#!/usr/bin/env bash
# Turn the Windows VPS on for a session. See README.md "Using the Windows VPS".
#
#   1. starts the instance
#   2. figures out your current public IP
#   3. opens a temporary RDP (3389) rule scoped to just that IP
#   4. waits for the instance to be running + passing status checks
#   5. prints the public IP and the decrypted Windows admin password
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="claude-spawn"
REGION="us-east-1"

INSTANCE_ID=$(terraform -chdir="$DIR" output -raw vps_instance_id)
SG_ID=$(terraform -chdir="$DIR" output -raw vps_security_group_id)
KEY_PATH="$DIR/spawn-vps-key.pem"
IP_FILE="$DIR/.vps-last-ip"

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "Starting instance $INSTANCE_ID ..."
aws_ ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null

MY_IP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
if [ -z "$MY_IP" ]; then
  echo "Could not determine your public IP (checkip.amazonaws.com unreachable)." >&2
  exit 1
fi
echo "Your public IP: $MY_IP"

# Clean up a stale rule from a previous session first (IP may have changed
# since then), then open the door for the current one.
if [ -f "$IP_FILE" ]; then
  OLD_IP=$(cat "$IP_FILE")
  aws_ ec2 revoke-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 3389 --cidr "${OLD_IP}/32" >/dev/null 2>&1 || true
fi
echo "$MY_IP" > "$IP_FILE"

echo "Opening RDP (3389) to ${MY_IP}/32 only ..."
aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 3389 --cidr "${MY_IP}/32" >/dev/null 2>&1 \
  || echo "  (rule for ${MY_IP}/32 already present)"

echo "Waiting for the instance to reach 'running' ..."
aws_ ec2 wait instance-running --instance-ids "$INSTANCE_ID"

echo "Waiting for status checks to pass (can take a couple of minutes) ..."
aws_ ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws_ ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo "Fetching the Windows admin password (can take several minutes on the very first boot after 'terraform apply') ..."
PASSWORD=""
for _ in $(seq 1 30); do
  PASSWORD=$(aws_ ec2 get-password-data --instance-id "$INSTANCE_ID" --priv-launch-key "$KEY_PATH" \
    --query PasswordData --output text 2>/dev/null || true)
  if [ -n "$PASSWORD" ] && [ "$PASSWORD" != "None" ]; then
    break
  fi
  sleep 20
done

echo
echo "================================================================"
echo " VPS is up."
echo "   RDP address : ${PUBLIC_IP}:3389"
echo "   Username    : Administrator"
if [ -n "$PASSWORD" ] && [ "$PASSWORD" != "None" ]; then
  echo "   Password    : $PASSWORD"
else
  echo "   Password    : not ready yet. Re-run this script in a minute, or:"
  echo "     aws ec2 get-password-data --instance-id $INSTANCE_ID --priv-launch-key $KEY_PATH --profile $PROFILE --region $REGION --query PasswordData --output text"
fi
echo "   RDP access is scoped to your current IP ($MY_IP) only."
echo "   When you're done: ./vps-stop.sh"
echo "================================================================"
