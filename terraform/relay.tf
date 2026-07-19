# Spawn relay — AWS free-tier deployment, PARALLEL to the existing Railway
# deployment (packages/relay/railway.json). This does not touch, replace, or
# decommission Railway; it's a separate environment for Marc to evaluate.
# Single EC2 instance, no load balancer (ALB isn't free-tier-forever, and a
# single box is all this needs).

# ── Code bundle (packages/relay -> S3 -> instance) ──────────────────────────
# Avoids needing git credentials on the box; also keeps user_data small
# (EC2 user-data has a 16KB limit) regardless of how the relay grows later.
data "archive_file" "relay_code" {
  type        = "zip"
  source_dir  = "${path.module}/../packages/relay"
  output_path = "${path.module}/.build/relay.zip"
  excludes    = ["node_modules"]
}

resource "aws_s3_bucket" "relay_code" {
  bucket = "spawn-relay-code-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "relay_code" {
  bucket                  = aws_s3_bucket.relay_code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "relay_code" {
  bucket = aws_s3_bucket.relay_code.id
  key    = "relay.zip"
  source = data.archive_file.relay_code.output_path
  etag   = data.archive_file.relay_code.output_md5
}

# ── Secrets (fresh for this environment — NOT the same values Railway uses) ─
# Generated once by scripts/bootstrap-secrets.sh into terraform.tfvars
# (gitignored), stored encrypted in SSM Parameter Store here, fetched by the
# instance at boot via its IAM role. Never written to git.
resource "aws_ssm_parameter" "relay_daemon_key" {
  name        = "/spawn/relay/daemon_key"
  description = "RELAY_DAEMON_KEY for the AWS relay (matches whatever daemon dials into this endpoint)."
  type        = "SecureString"
  value       = var.relay_daemon_key
}

resource "aws_ssm_parameter" "relay_dev_token" {
  name        = "/spawn/relay/dev_token"
  description = "RELAY_DEV_TOKEN for the AWS relay — a phone client auths with this until AUTH_JWT_SECRET/login is set up here too."
  type        = "SecureString"
  value       = var.relay_dev_token
}

# ── IAM role for the instance (S3 read of the code bundle, SSM read of the
# secrets above, plus SSM Session Manager for shell access without opening
# an SSH port) ────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "relay_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "relay" {
  name               = "spawn-relay-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.relay_assume.json
}

resource "aws_iam_role_policy_attachment" "relay_ssm_core" {
  role       = aws_iam_role.relay.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "relay_inline" {
  statement {
    sid       = "GetCodeBundle"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.relay_code.arn}/relay.zip"]
  }
  statement {
    sid     = "ReadRelaySecrets"
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.relay_daemon_key.arn,
      aws_ssm_parameter.relay_dev_token.arn,
    ]
  }
  statement {
    sid       = "DecryptSSMSecureString"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:us-east-1:${data.aws_caller_identity.current.account_id}:alias/aws/ssm"]
  }
}

resource "aws_iam_role_policy" "relay_inline" {
  name   = "spawn-relay-inline"
  role   = aws_iam_role.relay.id
  policy = data.aws_iam_policy_document.relay_inline.json
}

resource "aws_iam_instance_profile" "relay" {
  name = "spawn-relay-profile"
  role = aws_iam_role.relay.name
}

# ── Security group ───────────────────────────────────────────────────────
# Only the relay's own port is open, to the whole internet — that's the
# point of a relay phones connect to from anywhere. It's safe to expose
# because auth happens at the app layer (RELAY_DAEMON_KEY for the daemon,
# RELAY_DEV_TOKEN/JWT for phones) — see packages/relay/src/server.js.
# No SSH port: use SSM Session Manager (via the instance role above) for
# shell access instead — `aws ssm start-session --target <instance-id>`.
resource "aws_security_group" "relay" {
  name        = "spawn-relay-sg"
  description = "Spawn relay - public app port only (auth is at the app layer, not the network layer)"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "relay_app_port" {
  security_group_id = aws_security_group.relay.id
  description       = "Relay HTTP/WS endpoint"
  ip_protocol       = "tcp"
  from_port         = var.relay_port
  to_port           = var.relay_port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "relay_all_out" {
  security_group_id = aws_security_group.relay.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ── Instance ──────────────────────────────────────────────────────────────
locals {
  relay_user_data = templatefile("${path.module}/templates/relay-user-data.sh.tftpl", {
    region          = "us-east-1"
    bucket          = aws_s3_bucket.relay_code.bucket
    key             = aws_s3_object.relay_code.key
    daemon_key_name = aws_ssm_parameter.relay_daemon_key.name
    dev_token_name  = aws_ssm_parameter.relay_dev_token.name
    relay_port      = var.relay_port
  })
}

resource "aws_instance" "relay" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.relay_instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.relay.id]
  iam_instance_profile        = aws_iam_instance_profile.relay.name
  associate_public_ip_address = true
  user_data                   = local.relay_user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_type = "gp3"
    volume_size = 30 # AL2023's current AMI snapshot is 30GB; EC2 won't let the root volume be smaller
  }

  tags = {
    Name = "spawn-relay"
  }
}

output "relay_instance_id" {
  value = aws_instance.relay.id
}

output "relay_public_ip" {
  value = aws_instance.relay.public_ip
}

output "relay_endpoint" {
  value = "ws://${aws_instance.relay.public_ip}:${var.relay_port}"
}

output "relay_health_url" {
  value = "http://${aws_instance.relay.public_ip}:${var.relay_port}/health"
}
