# Windows VPS — deliberately OFF most of the time. Marc turns it on for a
# session (vps-start.sh), works over RDP, then turns it off (vps-stop.sh).
# `terraform apply` only provisions it once; day-to-day power state is
# managed by the two scripts below, outside Terraform, so the EBS volume
# (and anything installed on it) survives every stop/start cycle.

# ── Keypair ───────────────────────────────────────────────────────────────
# Generated ONCE by scripts/bootstrap-secrets.sh (plain ssh-keygen, PEM/RSA —
# `aws ec2 get-password-data --priv-launch-key` requires an RSA key in
# classic PEM format to decrypt the Windows admin password). Terraform just
# imports the public half; the private key (spawn-vps-key.pem) stays local
# and gitignored, read directly by vps-start.sh.
resource "aws_key_pair" "vps" {
  key_name   = "spawn-vps-key"
  public_key = file("${path.module}/spawn-vps-key.pub")
}

# ── Security group ─────────────────────────────────────────────────────────
# Deliberately NO ingress rules declared here. vps-start.sh/vps-stop.sh add
# and remove a single temporary RDP rule (scoped to the caller's current IP)
# via the AWS CLI directly. Because this resource has no `ingress` argument
# at all (and we use the separate per-rule resources below, only for
# egress), Terraform never touches ingress rules on this SG — the scripts'
# out-of-band rule survives every `terraform plan`/`apply` untouched.
resource "aws_security_group" "vps" {
  name        = "spawn-vps-sg"
  description = "Windows VPS - no ingress by default; vps-start.sh/vps-stop.sh manage a temporary RDP rule scoped to the callers IP"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_egress_rule" "vps_all_out" {
  security_group_id = aws_security_group.vps.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ── Instance ────────────────────────────────────────────────────────────────
# No Elastic IP (would cost while stopped and adds no value here — the start
# script prints whatever dynamic IP is assigned on each start).
resource "aws_instance" "vps" {
  ami                         = data.aws_ami.windows2022.id
  instance_type               = var.vps_instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.vps.id]
  key_name                    = aws_key_pair.vps.key_name
  associate_public_ip_address = true

  root_block_device {
    volume_type = "gp3"
    volume_size = 30 # matches the Windows Server 2022 AMI's own snapshot size; also the free-tier EBS cap
  }

  tags = {
    Name = "spawn-windows-vps"
  }

  # Power state (running/stopped) is managed by vps-start.sh/vps-stop.sh via
  # the AWS CLI, not by Terraform — ignore drift on those attributes.
  lifecycle {
    ignore_changes = [ami] # don't force a replacement just because a newer Windows AMI is published later
  }
}

output "vps_instance_id" {
  value = aws_instance.vps.id
}

output "vps_security_group_id" {
  value = aws_security_group.vps.id
}

output "vps_key_path" {
  value = "${path.module}/spawn-vps-key.pem"
}
