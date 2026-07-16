# Spawn daemon under launchd (optional, manual)

Phase 1 does **not** auto-install this. The desktop app already spawns the
daemon on demand (detached, logs to `spawn-daemon.log`); use launchd only if
you want the daemon up at login regardless of the app.

## Install

1. Copy `com.spawn.daemon.plist` to `~/Library/LaunchAgents/` and replace the
   placeholders:
   - `__NODE_BIN__` — absolute path to plain Node >= 20 (e.g. `/opt/homebrew/bin/node`)
   - `__SERVER_JS__` — absolute path to `packages/core/src/daemon/server.js`
   - `__SPAWN_DATA_DIR__` — absolute dir for runtime state (SQLite db, token,
     pid and log files)
2. Load it:

   ```sh
   launchctl load -w ~/Library/LaunchAgents/com.spawn.daemon.plist
   ```

The daemon single-instances itself via the port bind (a second start exits 0),
so launchd and an app-spawned daemon can coexist — whoever binds first wins.

## Uninstall

```sh
launchctl unload -w ~/Library/LaunchAgents/com.spawn.daemon.plist
rm ~/Library/LaunchAgents/com.spawn.daemon.plist
```
