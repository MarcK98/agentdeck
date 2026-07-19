#!/usr/bin/env bash
# Bring an archived VPS back (see vps-archive.sh). Recreates the instance
# from the snapshot AMI, so it returns exactly as it was archived — same
# installed software, same files, same Administrator password.
#
# After this finishes the instance exists but is stopped/off. Use it the
# normal way: ./vps-start.sh  (opens RDP + prints IP/password).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="claude-spawn"
REGION="us-east-1"
AMI_FILE="$DIR/.vps-archived-ami"

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# Existence via `state list` — after an archive's -target destroy, the
# `vps_instance_id` OUTPUT lingers stale, so an output-based check would
# wrongly think the box still exists.
if terraform -chdir="$DIR" state list 2>/dev/null | grep -q '^aws_instance\.vps$'; then
  echo "A VPS instance already exists in Terraform state — nothing to restore."
  echo "(If you meant to just turn it on, run ./vps-start.sh.)"
  exit 0
fi
if [ ! -f "$AMI_FILE" ]; then
  echo "No archive found (.vps-archived-ami missing). Nothing to restore." >&2
  echo "For a fresh box instead: terraform apply" >&2
  exit 1
fi

AMI_ID=$(cat "$AMI_FILE")
echo "Recreating the VPS from archive AMI $AMI_ID (a few minutes) ..."
# ignore_changes = [ami] on the instance means this custom AMI sticks; a
# later plain `terraform apply` won't try to swap it back to the base AMI.
terraform -chdir="$DIR" apply -target=aws_instance.vps -var="vps_ami=$AMI_ID" -auto-approve
# Reconcile outputs after the -target apply, so vps-start.sh/vps-stop.sh
# (which read `terraform output vps_instance_id`) see the new instance.
terraform -chdir="$DIR" apply -refresh-only -var="vps_ami=$AMI_ID" -auto-approve >/dev/null

# It comes up running; drop it to the normal stopped-by-default state.
NEW_ID=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=spawn-windows-vps" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
echo "Stopping $NEW_ID so 'off' stays the steady state ..."
aws_ ec2 stop-instances --instance-ids "$NEW_ID" >/dev/null
aws_ ec2 wait instance-stopped --instance-ids "$NEW_ID"

echo
echo "================================================================"
echo " VPS restored (and stopped). It's exactly as you archived it."
echo "   Turn it on for a session: ./vps-start.sh"
echo "================================================================"
