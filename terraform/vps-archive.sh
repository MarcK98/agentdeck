#!/usr/bin/env bash
# Archive the Windows VPS to ~$0 for long idle stretches.
#
# vps-stop.sh only STOPS the instance — the 30GB EBS disk keeps billing
# (~$2.40/month) even while stopped. This goes further: it snapshots the
# disk into an AMI, then destroys the instance + its EBS volume, so storage
# drops to just the snapshot (~$0.50-0.75/month, incremental/compressed).
# Everything you installed/configured is preserved in the snapshot.
#
# Bring it back later with ./vps-restore.sh (comes up exactly as archived).
#
# Trade-off vs. plain vps-stop.sh: restoring takes a few minutes (recreate
# from snapshot) instead of the ~1 min a stopped instance takes to start.
# Use this for "won't touch it for weeks"; use vps-stop.sh for "done for today".
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="claude-spawn"
REGION="us-east-1"
AMI_FILE="$DIR/.vps-archived-ami"

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# Existence via `state list` (robust — `terraform output` can go stale after a
# prior -target op); the actual id via the AWS tag (never stale).
if ! terraform -chdir="$DIR" state list 2>/dev/null | grep -q '^aws_instance\.vps$'; then
  echo "No VPS instance in Terraform state — already archived? (nothing to do)"
  [ -f "$AMI_FILE" ] && echo "Existing archive AMI: $(cat "$AMI_FILE") — run ./vps-restore.sh to bring it back."
  exit 0
fi
INSTANCE_ID=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=spawn-windows-vps" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "Terraform thinks the VPS exists but AWS has no such instance — run 'terraform apply' to reconcile." >&2
  exit 1
fi

# Close any lingering RDP rule + stop first, so the snapshot is clean.
echo "Making sure RDP is closed and the instance is stopped ..."
"$DIR/vps-stop.sh" >/dev/null 2>&1 || true
aws_ ec2 wait instance-stopped --instance-ids "$INSTANCE_ID" 2>/dev/null || true

STAMP=$(aws_ ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].LaunchTime' --output text | tr -dc '0-9')
echo "Creating an AMI snapshot of $INSTANCE_ID (this takes a few minutes) ..."
AMI_ID=$(aws_ ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "spawn-vps-archive-${STAMP:-manual}" \
  --description "Spawn Windows VPS archive snapshot" \
  --no-reboot \
  --tag-specifications 'ResourceType=image,Tags=[{Key=Project,Value=spawn},{Key=ManagedBy,Value=vps-archive.sh}]' \
  --query ImageId --output text)
echo "  AMI: $AMI_ID — waiting for it to finish ..."
aws_ ec2 wait image-available --image-ids "$AMI_ID"
echo "$AMI_ID" > "$AMI_FILE"

echo "Destroying the instance + its EBS volume (snapshot is safe in the AMI) ..."
terraform -chdir="$DIR" destroy -target=aws_instance.vps -auto-approve

echo
echo "================================================================"
echo " VPS archived. EBS storage cost is now ~\$0 (only the snapshot"
echo " remains, ~\$0.50-0.75/month). The instance is gone."
echo "   Archive AMI: $AMI_ID  (saved to .vps-archived-ami)"
echo "   Bring it back anytime: ./vps-restore.sh"
echo "================================================================"
