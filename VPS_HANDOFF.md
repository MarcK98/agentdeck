# VPS handoff — turn the Windows VPS on/off

A shared Windows VPS you can start and stop yourself, for a few hours at a
time. **No AWS account needed** — you toggle it through a small control
endpoint using a token.

## What Marc gives you (privately — these are NOT in this repo)

1. A **control URL** + **token** (two values).
2. The **Windows Administrator password**.

Keep them safe; don't paste them into the repo, issues, or chat.

## One-time setup (~30 seconds)

You need `bash` + `curl` (already on macOS/Linux; `node` is optional, just for
prettier output). No AWS CLI, no Terraform.

```sh
cd terraform
cp .vps-control.env.example .vps-control.env
# open .vps-control.env and paste the URL + token Marc gave you
```

## Turn it on / off

```sh
cd terraform
./vpsctl.sh on       # starts it, opens RDP to your current IP, prints the IP
./vpsctl.sh status   # is it on? what's the IP?
./vpsctl.sh off      # stops it when you're done
```

## Remote in

1. `./vpsctl.sh on` — it prints a public IP.
2. Open any RDP client (Windows Remote Desktop, or "Microsoft Remote Desktop"
   on macOS) and connect to `<that-ip>:3389`.
3. Username: `Administrator`. Password: the one Marc gave you.

## Please turn it OFF when you're done

```sh
./vpsctl.sh off
```

This stops the machine (so it's not costing money) and closes RDP. Anything
you installed or saved **persists** to next time — only the compute is off.
Don't leave it running idle.

## Good to know

- `on` opens RDP to **your** current IP only. If your network/IP changes
  mid-session, just run `./vpsctl.sh on` again to re-open access.
- The public IP is **different every time** it's turned on — always use the IP
  that `on`/`status` prints, don't bookmark one.
- The tooling never handles the Windows password (you get that from Marc). Your
  token only lets you turn **this one VPS** on/off/status — it grants no other
  AWS access, and Marc can revoke it anytime.
