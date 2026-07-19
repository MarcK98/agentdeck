# Spawn AWS infrastructure (Terraform)

Two independent pieces, both in a dedicated AWS account (`772147490512`,
`us-east-1`), managed via the `claude-spawn` AWS CLI profile:

1. **Relay** — the Spawn relay (`packages/relay`) running on a free-tier EC2
   box, **parallel to the existing Railway deployment**. This does NOT touch,
   replace, or decommission Railway (`packages/relay/railway.json`, live at
   the `wss://...railway.app` endpoint) — it's a separate environment for
   evaluation. Cutting over is Marc's call, later.
2. **Windows VPS** — a Windows Server box that's normally **off**. Turn it on
   for a session, RDP in, do the work, turn it off. See "Using the Windows
   VPS" below — that's the only part you need to remember day-to-day.

## Prerequisites

- AWS CLI configured with a `claude-spawn` profile (already set up).
- Terraform >= 1.5.
- `openssl` and `ssh-keygen` (both ship with macOS).

## First-time setup

```sh
cd terraform
./scripts/bootstrap-secrets.sh   # generates terraform.tfvars + the VPS RSA keypair (gitignored, run once)
terraform init
terraform plan
terraform apply
./vps-stop.sh                    # apply launches the VPS running — immediately stop it so "off" is the steady state
```

If `terraform init` fails with `Invalid provider registry host` (only seen on
networks that block `registry.terraform.io` outright), there's a
`.terraformrc.local` in this directory with a filesystem-mirror-only config
that doesn't need the registry at all:

```sh
export TF_CLI_CONFIG_FILE="$PWD/.terraformrc.local"
terraform init
```

This does not touch your global `~/.terraformrc`; only set it for this repo
if plain `terraform init` doesn't work for you.

## Using the Windows VPS

This is the only day-to-day workflow:

```sh
cd terraform
./vps-start.sh     # turns it on, opens RDP to your IP only, prints the address + password
#  ... RDP in, do your work ...
./vps-stop.sh      # closes RDP, turns it off
```

`vps-start.sh` starts the instance, detects your current public IP, opens a
temporary RDP (3389) rule scoped to just that IP, waits for the instance to
be fully up, then prints the RDP address and the decrypted Administrator
password. `vps-stop.sh` removes that temporary rule and stops the instance —
**not** `terraform destroy`, so the disk (and anything you installed/saved)
is exactly as you left it next time.

### Going idle for a long time (optional — get the VPS to ~$0)

`vps-stop.sh` stops the box but its 30GB disk keeps billing (~$2.40/month)
even while off. If you won't touch it for weeks, archive it instead:

```sh
./vps-archive.sh    # snapshots the disk to an AMI, then destroys the instance + its EBS volume
#  ... weeks pass, paying only ~$0.50-0.75/month for the snapshot ...
./vps-restore.sh    # recreates it from the snapshot, exactly as you left it
./vps-start.sh      # then use it normally
```

`vps-archive.sh` preserves everything you installed (it's all in the
snapshot) and drops ongoing storage cost to just the snapshot.
`vps-restore.sh` brings it back (same software, same files, same admin
password) and leaves it stopped. Trade-off: restore takes a few minutes vs.
the ~1 minute a merely-stopped instance takes to start — so use
`vps-stop.sh` for "done for today" and `vps-archive.sh` for "done for a
while". Day-to-day start/stop is unchanged.

Notes:
- No Elastic IP — the public address changes on every start. The script
  always prints the current one; don't bookmark an IP.
- RDP is closed except during an active session, and only to whoever ran
  `vps-start.sh` last. If your IP changes mid-session, re-run
  `vps-start.sh` to re-open access for the new one.
- The very first password fetch (right after `terraform apply`, before
  Windows has finished its first real boot) can take a few minutes — the
  script retries automatically. Every start after that returns the password
  immediately (it's set once at first boot, not regenerated per session).

## The relay

It just runs continuously — nothing to start/stop day-to-day. Useful commands:

```sh
terraform output relay_public_ip      # current address (changes only if the instance is ever replaced)
terraform output relay_endpoint       # ws://<ip>:8820
terraform output relay_health_url     # http://<ip>:8820/health
curl "$(terraform output -raw relay_health_url)"

# The token a phone/daemon client authenticates with (RELAY_DEV_TOKEN):
aws ssm get-parameter --name /spawn/relay/dev_token --with-decryption \
  --profile claude-spawn --region us-east-1 --query Parameter.Value --output text

# The daemon-side shared secret (RELAY_DAEMON_KEY):
aws ssm get-parameter --name /spawn/relay/daemon_key --with-decryption \
  --profile claude-spawn --region us-east-1 --query Parameter.Value --output text

# Shell on the box without any SSH port open, via SSM Session Manager:
aws ssm start-session --target "$(terraform output -raw relay_instance_id)" \
  --profile claude-spawn --region us-east-1
```

These are **fresh secrets generated for this AWS environment** — not the
same `RELAY_DAEMON_KEY`/`RELAY_DEV_TOKEN` values Railway uses. Pointing a
real daemon or phone at this endpoint is a separate, deliberate step later;
right now nothing is wired to it.

Updating the relay's code: edit `packages/relay/`, then `terraform apply` —
this re-zips the code, uploads it, and replaces the instance (the box has no
state of its own, so this is safe; it'll come up with a new public IP).

## Security model

- **Relay port (8820) is open to the whole internet, by design.** That's the
  point of a relay phones connect to from anywhere — it's protected by
  app-layer auth (`RELAY_DAEMON_KEY` for the daemon, a dev token/JWT for
  phones), not by network restriction. Same model the Railway deployment
  already uses.
- **No SSH port anywhere.** Both instances use IAM + SSM Session Manager for
  administrative shell access (the relay only — the VPS doesn't need it,
  RDP is the intended access path).
- **RDP (3389) is closed by default** and only ever open to one specific
  `/32` at a time, only while `vps-start.sh` has it open, only until
  `vps-stop.sh` (or the next start, which rotates it) removes it.
- Relay secrets live in SSM Parameter Store as `SecureString` (KMS-encrypted
  with the AWS-managed key), fetched by the instance via its IAM role at
  boot — never committed to git, never baked into the AMI/user-data as
  plaintext beyond the running instance's own env file (`/etc/spawn-relay.env`,
  mode 600).
- The VPS's private key (`spawn-vps-key.pem`) and the relay's secrets
  (`terraform.tfvars`) are local, gitignored files — see `.gitignore`.

## Remote backend (optional upgrade, not required now)

State is local (`terraform.tfstate`, gitignored) — fine for one person on one
machine. If this ever needs multi-machine or team access, or you want
state to survive a laptop wipe, upgrade to an S3+DynamoDB backend:
https://developer.hashicorp.com/terraform/language/backend/s3. Not needed
for solo use.

## Cost

Actual current configuration: both instances are `t3.micro`; the relay's
root volume ended up 30GB gp3 (Amazon Linux 2023's current AMI snapshot is
30GB — EC2 won't let you launch with a smaller root volume than the AMI's
own snapshot, even though the relay itself uses almost none of it); the VPS
is also 30GB gp3 (matches the Windows Server 2022 AMI's own snapshot size,
and the free-tier EBS cap).

**Important — this is a *member* account in an AWS Organization**
(management account `603657357170`). AWS Free Tier eligibility for an
organization is tied to the **management account's age**: if that org is
more than 12 months old, member accounts get **no free tier at all**, and
the "worst case" table below is effectively the *actual* cost. I can't
check the management account's age from this member account's credentials.
(The newer credits-based free plan also doesn't apply to Organization
member accounts.) So don't assume free-tier coverage — verify in the
console.

**I could not get an authoritative answer, for this specific account, on
which AWS Free Tier offer applies** — Cost Explorer access is denied for
the `terraform` IAM user even with AdministratorAccess (needs enabling
separately), and the account has no usage yet for the Free Tier usage API
to report anything. AWS's free tier terms also changed for accounts created
after mid-2024 (credits-based model instead of the classic
"12 months of specific service allowances" model). **Please check
Billing → Free Tier in the AWS Console for the authoritative numbers for
this account** — the figures below are my best understanding of the
classic, commonly-documented terms, clearly split into what's essentially
certain vs. what depends on which offer applies.

**Essentially certain, regardless of free-tier offer type** (a structural
limit, not a time-boxed allowance):
- The classic EBS free tier caps out at 30GB total (gp2/gp3) across the
  whole account. Between the two 30GB volumes here, that's 60GB combined —
  **~30GB will be billed** at the gp3 rate (~$0.08/GB-month) ≈
  **~$2.40/month**, all the time, whether or not either instance is running
  (EBS storage bills regardless of instance power state).

**If the classic 12-months-free allowances apply to this account** (750
hrs/month each of Linux and Windows t2/t3.micro compute, plus a public-IPv4
allowance mirroring that): the relay's ~730 hrs/month of Linux compute and
its one public IP likely consume most/all of that bucket, but stay at or
near **$0** for compute+IP; the VPS's occasional "a few hours" usage is
comfortably within a separate Windows-hours allowance. **Total: roughly the
~$2.40/month EBS overage above, and nothing else.**

**Worst case — if nothing here is free-tier-covered** (e.g. a newer
credits-based account where these specific allowances don't apply, or the
12 months has lapsed):
| Item | Rate | Usage | Est. monthly |
|---|---|---|---|
| Relay EC2 (t3.micro, Linux) | ~$0.0104/hr | ~730 hr (continuous) | ~$7.59 |
| Relay EBS (gp3) | ~$0.08/GB-mo | 30 GB | ~$2.40 |
| Relay public IPv4 | ~$0.005/hr | ~730 hr (continuous) | ~$3.65 |
| VPS EC2 (t3.micro, Windows) | ~$0.0166/hr | ~10 hr/mo (a few sessions) | ~$0.17 |
| VPS EBS (gp3) | ~$0.08/GB-mo | 30 GB (bills even while stopped) | ~$2.40 |
| VPS public IPv4 | ~$0.005/hr | ~10 hr/mo (only while on) | ~$0.05 |
| S3 (relay code bundle, ~10KB) | — | negligible | ~$0.00 |
| SSM Parameter Store (Standard tier) | — | no request charge | $0.00 |
| **Total (worst case)** | | | **~$16/month** |

The VPS's own cost is trivial either way (a few dimes to low single
dollars/month) *because* it's off most of the time — that's the entire
point of the start/stop design. The one line item that's genuinely
worth knowing about regardless of free-tier status is the ~$2.40/month EBS
overage from running two 30GB volumes simultaneously; everything else is
either free or rounds to pennies for how lightly this is used.

**Driving the VPS to ~$0 when idle:** `vps-archive.sh` snapshots the disk
and destroys the instance + its EBS volume, so that ~$2.40/month VPS-EBS
line drops to ~$0.50–0.75/month of snapshot storage until you
`vps-restore.sh` it (see "Going idle for a long time" above). And since the
relay already runs on Railway, the AWS relay is optional — destroying it
(`terraform destroy -target=aws_instance.relay`, `-target=aws_s3_object`,
etc., or just `terraform destroy` for everything) removes the largest cost
items (relay compute + public IPv4 + its 30GB EBS). **There is no
free-forever always-on compute on AWS**, so a 24/7 relay can't be $0 here
long-term — that's why Railway remains the primary and this AWS relay is a
parallel/optional environment.

## What's been tested

- Relay: deployed, `/health` returns `{"ok":true,...}` from its real public
  IP; verified via SSM that `spawn-relay.service` is `active (running)` and
  `enabled` (survives reboot); did a real WebSocket auth round-trip against
  the live endpoint — the generated dev token is accepted (`{"relay":
  "daemon-offline"}`, correct since no daemon points here yet) and a bad
  token is rejected (`close 4001`).
- VPS: ran `vps-start.sh` for real — instance started, RDP opened to the
  actual detected caller IP, instance reached `running` + passing status
  checks, password decrypted and printed. Confirmed port 3389 was reachable
  from the scoped IP (`nc -zv` succeeded) and the security group held
  exactly one rule, scoped to that `/32`. Then ran `vps-stop.sh` — confirmed
  the ingress rule was removed (security group back to zero ingress rules)
  and the instance reached `stopped`.
