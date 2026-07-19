#!/usr/bin/env bash
# Turn the Windows VPS off. See README.md "Using the Windows VPS".
#
#   1. removes the temporary RDP ingress rule(s)
#   2. stops the instance (NOT terraform destroy — the EBS disk and
#      anything installed/saved on it survives; only the compute is billed
#      while stopped, which is $0)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="claude-spawn"
REGION="us-east-1"

INSTANCE_ID=$(terraform -chdir="$DIR" output -raw vps_instance_id)
SG_ID=$(terraform -chdir="$DIR" output -raw vps_security_group_id)
IP_FILE="$DIR/.vps-last-ip"

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

if [ -f "$IP_FILE" ]; then
  LAST_IP=$(cat "$IP_FILE")
  echo "Removing temporary RDP access for $LAST_IP ..."
  aws_ ec2 revoke-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 3389 --cidr "${LAST_IP}/32" >/dev/null 2>&1 || true
  rm -f "$IP_FILE"
fi

# Defensive: in case the ip-file was lost/stale, sweep any other :3389 rules
# still on this SG so nothing is left open after the instance goes down.
LEFTOVER=$(aws_ ec2 describe-security-groups --group-ids "$SG_ID" \
  --query "SecurityGroups[0].IpPermissions[?ToPort==\`3389\`].IpRanges[].CidrIp" --output text 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  for cidr in $LEFTOVER; do
    echo "Revoking lingering RDP rule for $cidr ..."
    aws_ ec2 revoke-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 3389 --cidr "$cidr" >/dev/null 2>&1 || true
  done
fi

echo "Stopping instance $INSTANCE_ID ..."
aws_ ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws_ ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"

echo "Stopped. RDP is closed and the instance is off — no compute charges while stopped."
echo "(The EBS disk persists, so anything installed/saved is still there next time.)"
