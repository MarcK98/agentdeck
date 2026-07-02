# claude-channel-bridge

Local Node server that watches chat channels (Discord for now) and forwards every incoming message to Claude Code (`claude -p`), replying in the channel with Claude's output.

## Setup

1. **Create a Discord bot** at https://discord.com/developers/applications
   - Bot tab → enable **MESSAGE CONTENT INTENT**
   - OAuth2 → URL Generator → scope `bot`, permissions `Send Messages`, `Read Message History` → invite it to your server
2. **Configure**
   ```sh
   cp .env.example .env
   # paste DISCORD_BOT_TOKEN, adjust the rest as needed
   ```
3. **Run**
   ```sh
   npm install
   npm start
   ```

DM the bot, or @mention it in a channel it can see. Each Discord channel keeps its own Claude conversation (via `--resume`, stored in `sessions.json`).

## How it works

```
Discord ──messageCreate──▶ src/channels/discord.js
                                │  sessionKey = discord:<channelId>
                                ▼
                          src/claude.js ──spawn──▶ claude -p "<msg>" --output-format json [--resume <id>]
                                │
                                ◀── { result, session_id }
                                ▼
                          reply back in channel (chunked to 2000 chars)
```

Messages within one channel are queued so replies stay in order.

## Per-channel projects

Each Discord channel maps to its own project folder, and Claude runs *inside* that folder — so every project gets its own `CLAUDE.md`, `.mcp.json` (project MCPs), `.claude/skills/`, and separate chat history (Claude Code stores sessions per working directory).

Resolution order for a message in `#my-app`:

1. `projects.json` override by channel ID
2. `projects.json` override by channel name
3. `<PROJECTS_ROOT>/my-app` (folder must exist)
4. `DEFAULT_PROJECT` (also used for DMs)
5. otherwise the channel is ignored

Optional `projects.json` (repo root):

```json
{
  "my-app": "/Users/mkhoury/Documents/some-other-folder",
  "123456789012345678": "/Users/mkhoury/Documents/mapped-by-channel-id"
}
```

Setup per project folder: add a `CLAUDE.md` for instructions, a `.mcp.json` for project MCP servers, and `.claude/skills/` for skills. Run `claude` manually in the folder once to approve project MCPs — headless `-p` runs won't show the trust prompt.

## Approvals & questions

When Claude needs permission (run a command, edit a file, use an MCP tool), the bridge posts the request in the originating channel with **Allow / Deny** buttons. Unanswered prompts auto-deny after `APPROVAL_TIMEOUT_SECONDS`. Anyone who can press buttons in the channel can approve — keep the server private.

Plumbing: `claude -p` runs with `--permission-prompt-tool mcp__approver__approve` (injected via `--mcp-config`); that MCP server forwards the request to the bridge on `127.0.0.1:APPROVAL_PORT`, which renders the buttons and returns allow/deny.

If Claude asks a clarifying question, it arrives as a normal reply — just answer in the channel (@mention it again if `DISCORD_REQUIRE_MENTION=true`); `--resume` continues the same conversation.

## Adding more channels

Write an adapter in `src/channels/<name>.js` exporting an async `start<Name>()` that returns a `stop()` function, register it in `ADAPTERS` in `src/index.js`, and add `<name>` to `CHANNELS` in `.env`. Telegram (`node-telegram-bot-api`, long polling) and Slack (`@slack/bolt` Socket Mode) both work locally without a public URL.

## Safety notes

- Anyone who can message the bot can drive Claude Code in `CLAUDE_CWD`. Keep `DISCORD_REQUIRE_MENTION=true` and use `DISCORD_ALLOWED_CHANNELS` in shared servers.
- By default `claude -p` runs with your CLI's default permission mode; restrict it with e.g. `CLAUDE_EXTRA_ARGS=--allowedTools "Read,Grep,Glob"` if you only want read-only access.
