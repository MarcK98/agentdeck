variable "relay_instance_type" {
  description = "Free-tier eligible instance type for the relay EC2 host."
  type        = string
  default     = "t3.micro"
}

variable "relay_port" {
  description = "Port the relay's HTTP/WS server listens on; opened publicly (app-layer auth protects it — see README)."
  type        = number
  default     = 8820
}

variable "vps_instance_type" {
  description = "Free-tier eligible instance type for the Windows VPS."
  type        = string
  default     = "t3.micro"
}

variable "vps_ami" {
  description = "Override AMI for the VPS. Empty = latest Windows Server 2022 base AMI. vps-restore.sh sets this to a snapshot AMI created by vps-archive.sh, so the box comes back with everything you'd installed on it. Leave empty for a fresh box."
  type        = string
  default     = ""
}

# ── Secrets — set via terraform.tfvars (gitignored), NOT committed.
# Generate with: ./scripts/bootstrap-secrets.sh
variable "relay_daemon_key" {
  description = "RELAY_DAEMON_KEY for this AWS relay (fresh value — not the same secret Railway uses)."
  type        = string
  sensitive   = true
}

variable "relay_dev_token" {
  description = "RELAY_DEV_TOKEN for this AWS relay (fresh value — not the same secret Railway uses)."
  type        = string
  sensitive   = true
}
