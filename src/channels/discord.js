import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { askClaude } from "../claude.js";
import { resolveProject } from "../projects.js";
import { setPermissionHandler } from "../permission-server.js";
import { downloadAttachments, cleanupAttachments } from "../attachments.js";
import {
  runBridgeCommand,
  isInteractiveCommandMiss,
  progressLabel,
} from "../commands.js";
import { registerPrReviewer } from "../pr-reviewer.js";

const MAX_DISCORD_LEN = 2000;

// ── Permission prompt formatting ─────────────────────────────────────────────

const clip = (s, max) =>
  s.length > max ? s.slice(0, max - 15) + "\n… (truncated)" : s;

const codeBlock = (lang, s, max = 3200) =>
  "```" + lang + "\n" + clip(s, max) + "\n```";

// Human-readable summary per tool. Embed descriptions allow 4096 chars.
function formatPermission(toolName, input) {
  switch (toolName) {
    case "Bash":
      return {
        title: "Run a terminal command",
        body:
          (input.description ? `*${input.description}*\n` : "") +
          codeBlock("bash", input.command ?? ""),
      };
    case "Edit":
      return {
        title: `Edit ${input.file_path ?? "a file"}`,
        body:
          "**Replace:**" +
          codeBlock("", input.old_string ?? "", 1500) +
          "**With:**" +
          codeBlock("", input.new_string ?? "", 1500),
      };
    case "Write":
      return {
        title: `Write ${input.file_path ?? "a file"}`,
        body: codeBlock("", input.content ?? ""),
      };
    case "Read":
      return { title: `Read ${input.file_path ?? "a file"}`, body: "" };
    case "Glob":
    case "Grep":
      return {
        title: `Search files (${toolName})`,
        body: codeBlock("", JSON.stringify(input, null, 2)),
      };
    case "WebFetch":
      return { title: "Fetch a web page", body: input.url ?? "" };
    case "WebSearch":
      return { title: "Search the web", body: `Query: **${input.query ?? ""}**` };
    default: {
      // MCP tools look like mcp__server__tool_name
      const m = toolName.match(/^mcp__(.+?)__(.+)$/);
      const title = m
        ? `Use **${m[2].replaceAll("_", " ")}** (${m[1]})`
        : `Use the ${toolName} tool`;
      return {
        title,
        body: codeBlock("json", JSON.stringify(input, null, 2)),
      };
    }
  }
}

const chunk = (text) => {
  const parts = [];
  for (let i = 0; i < text.length; i += MAX_DISCORD_LEN) {
    parts.push(text.slice(i, i + MAX_DISCORD_LEN));
  }
  return parts.length ? parts : ["(empty response)"];
};

// ── Terminal mode (interactive commands like /workflows) ─────────────────────
// The PTY/terminal-emulator deps are native and loaded lazily, so a load
// failure degrades to "terminal unavailable" instead of crashing the bridge.
let termMod = null;
let termLoadFailed = false;
async function loadTerminal() {
  if (termMod) return termMod;
  if (termLoadFailed) return null;
  try {
    termMod = await import("../terminal.js");
    return termMod;
  } catch (err) {
    termLoadFailed = true;
    log.error("[terminal] mode unavailable:", err.message);
    return null;
  }
}
// Safe synchronous check — a terminal can only exist if the module loaded.
const inTerminal = (sessionKey) => Boolean(termMod?.hasTerminal(sessionKey));

const isTerminalTrigger = (userText) => {
  const cmd = userText.trim().split(/\s+/)[0]?.toLowerCase();
  return cmd === "/terminal" || config.terminal.triggers.includes(cmd);
};

const SCREEN_MAX = 1900; // leave room for the ``` fences within 2000 chars
const codeScreen = (text) =>
  "```\n" + (text || "(blank screen)").slice(0, SCREEN_MAX) + "\n```";

// Button rows to drive the TUI: navigation + Enter, then Esc / Ctrl-C / Exit.
const terminalControls = () => {
  const btn = (id, label) =>
    new ButtonBuilder()
      .setCustomId(`term:${id}`)
      .setLabel(label)
      .setStyle(id === "exit" ? ButtonStyle.Danger : ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(
      btn("up", "↑"),
      btn("down", "↓"),
      btn("left", "←"),
      btn("right", "→"),
      btn("enter", "⏎ Enter")
    ),
    new ActionRowBuilder().addComponents(
      btn("space", "␣ Space"),
      btn("esc", "Esc"),
      btn("ctrlc", "Ctrl-C"),
      btn("exit", "🚪 Exit")
    ),
  ];
};

// Per-channel Discord UI for an open terminal: the live screen message + its
// button collector.
const termUI = new Map(); // sessionKey -> { screenMsg, collector }

async function startTerminal(channel, sessionKey, projectDir, initialCommand) {
  const controls = terminalControls();
  const screenMsg = await channel
    .send({ content: codeScreen("starting terminal…"), components: controls })
    .catch(() => null);
  if (!screenMsg) return;

  // Coalesce rapid renders into one in-flight edit, always showing the latest.
  let pending = null;
  let editing = false;
  const pushRender = async (text) => {
    pending = text;
    if (editing) return;
    editing = true;
    try {
      while (pending !== null) {
        const t = pending;
        pending = null;
        await screenMsg
          .edit({ content: codeScreen(t), components: controls })
          .catch(() => {});
      }
    } finally {
      editing = false;
    }
  };

  termMod.openTerminal(sessionKey, {
    cwd: projectDir,
    onRender: (text) => pushRender(text),
    onExit: async (reason) => {
      const ui = termUI.get(sessionKey);
      termUI.delete(sessionKey);
      ui?.collector?.stop();
      await screenMsg.edit({ components: [] }).catch(() => {});
      await channel
        .send(`🖥️ Left terminal mode${reason ? ` — ${reason}` : ""}.`)
        .catch(() => {});
    },
  });

  const collector = screenMsg.createMessageComponentCollector();
  collector.on("collect", async (i) => {
    await i.deferUpdate().catch(() => {});
    const id = i.customId.replace(/^term:/, "");
    if (id === "exit") termMod.closeTerminal(sessionKey, "closed with the button");
    else termMod.writeKey(sessionKey, id);
  });

  termUI.set(sessionKey, { screenMsg, collector });

  await channel
    .send(
      "🖥️ **Terminal mode.** This screen updates live — type to enter text, " +
        "use the buttons to navigate, and send `/exit` to leave."
    )
    .catch(() => {});

  // Type the triggering command once the session has booted past any dialogs.
  if (initialCommand) {
    setTimeout(
      () => termMod.writeLine(sessionKey, initialCommand),
      config.terminal.bootMs
    );
  }
}

export async function startDiscord() {
  const { token, allowedChannels, requireMention } = config.discord;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set (see .env.example)");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // needed to receive DMs
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;

      const isDM = message.channel.type === ChannelType.DM;
      const sessionKey = `discord:${message.channelId}`;

      if (
        allowedChannels.length &&
        !isDM &&
        !allowedChannels.includes(message.channelId)
      ) {
        return;
      }

      // While a terminal is open, drop the mention requirement so every line
      // reaches the PTY.
      const mentioned = message.mentions.users.has(client.user.id);
      if (!isDM && requireMention && !mentioned && !inTerminal(sessionKey)) return;

      // Strip the bot mention from the prompt / terminal input.
      const userText = message.content
        .replaceAll(`<@${client.user.id}>`, "")
        .trim();

      // Terminal mode: route the message straight to the live PTY session.
      if (inTerminal(sessionKey)) {
        if (/^\/(exit|close|quit)\b/i.test(userText)) {
          termMod.closeTerminal(sessionKey, "closed by you");
        } else if (userText) {
          termMod.writeLine(sessionKey, userText);
        }
        return;
      }

      // Each channel maps to its own project directory (own CLAUDE.md,
      // .mcp.json, skills, and chat history).
      const projectDir = resolveProject({
        channelId: message.channelId,
        channelName: isDM ? null : message.channel.name,
        isDM,
      });
      if (!projectDir) return;

      // Interactive commands (/workflows, /terminal, …) open a live terminal
      // instead of failing headlessly.
      if (config.terminal.enabled && isTerminalTrigger(userText)) {
        const mod = await loadTerminal();
        if (!mod) {
          await message
            .reply("Terminal mode is unavailable — the native terminal deps failed to load.")
            .catch(() => {});
          return;
        }
        const initial = /^\/terminal\b/i.test(userText) ? "" : userText;
        await startTerminal(message.channel, sessionKey, projectDir, initial);
        return;
      }

      // Bridge commands (/reset, /stop, /help) are handled here and never sent
      // to Claude. Other slash commands fall through to Claude Code as-is.
      const bridgeReply = runBridgeCommand({ text: userText, sessionKey, projectDir });
      if (bridgeReply !== null) {
        let first = true;
        for (const part of chunk(bridgeReply)) {
          if (first) {
            first = false;
            await message.reply(part).catch(() => {});
          } else {
            await message.channel.send(part).catch(() => {});
          }
        }
        return;
      }

      // Download any attachments to a temp folder Claude can read from.
      const attachments = [...message.attachments.values()];
      let attachmentDir = null;
      let savedCount = 0;
      const addDirs = [];
      let attachmentNote = "";
      if (config.attachments.enabled && attachments.length) {
        const { dir, files, skipped } = await downloadAttachments(
          `discord-${message.channelId}-${message.id}`,
          attachments.map((a) => ({
            url: a.url,
            name: a.name,
            contentType: a.contentType,
            size: a.size,
          }))
        );
        attachmentDir = dir; // remove even if nothing usable landed
        savedCount = files.length;
        if (files.length) {
          addDirs.push(dir);
          const listing = files
            .map((f) => `- ${f.path}${f.contentType ? ` (${f.contentType})` : ""}`)
            .join("\n");
          attachmentNote =
            `\n\nThe user attached the following file(s). ` +
            `Read them from disk as needed:\n${listing}`;
        }
        for (const s of skipped) {
          message.reply(`⚠️ Skipped attachment **${s.name}**: ${s.reason}`).catch(() => {});
        }
      }

      const prompt = (userText + attachmentNote).trim();
      // Nothing to act on (empty message, or every attachment was skipped).
      if (!prompt) {
        if (attachmentDir) cleanupAttachments(attachmentDir);
        return;
      }

      log.info(
        `[discord] ${message.author.tag} in #${isDM ? "DM" : message.channel.name}: ${
          userText.slice(0, 80) || "(no text)"
        }${savedCount ? ` [+${savedCount} attachment(s)]` : ""}`
      );

      await message.channel.sendTyping();
      const typing = setInterval(
        () => message.channel.sendTyping().catch(() => {}),
        8000
      );

      // Serialize sends so streamed chunks arrive in order. The first
      // chunk replies to the user's message; the rest are plain sends.
      let replied = false;
      let sendQueue = Promise.resolve();
      const send = (text) => {
        sendQueue = sendQueue
          .then(async () => {
            for (const part of chunk(text)) {
              if (!replied) {
                replied = true;
                await message.reply(part);
              } else {
                await message.channel.send(part);
              }
            }
          })
          .catch((err) => log.warn("[discord] send failed:", err.message));
        return sendQueue;
      };

      // Live progress (feature C): one status message showing the tool Claude
      // is currently running, edited in place and throttled to dodge rate
      // limits. Removed when the run finishes — the real output is streamed.
      let statusMsg = null;
      let statusChain = Promise.resolve();
      let statusLatest = "";
      let statusSteps = 0;
      let lastStatusEdit = 0;
      const STATUS_THROTTLE_MS = 1500;

      const flushStatus = () => {
        const text = `⏳ Working — ${statusSteps} step${
          statusSteps === 1 ? "" : "s"
        }\n${statusLatest}`.slice(0, MAX_DISCORD_LEN);
        statusChain = statusChain.then(async () => {
          if (statusMsg) await statusMsg.edit(text).catch(() => {});
          else statusMsg = await message.channel.send(text).catch(() => null);
        });
      };

      const onProgress = config.progress.enabled
        ? (ev) => {
            statusSteps++;
            statusLatest = progressLabel(ev);
            const now = Date.now();
            if (now - lastStatusEdit >= STATUS_THROTTLE_MS) {
              lastStatusEdit = now;
              flushStatus();
            }
          }
        : undefined;

      const clearStatus = () =>
        (statusChain = statusChain.then(async () => {
          if (statusMsg) await statusMsg.delete().catch(() => {});
          statusMsg = null;
        }));

      const res = await askClaude(sessionKey, prompt, projectDir, send, {
        addDirs,
        onProgress,
      }).finally(() => {
        clearInterval(typing);
        cleanupAttachments(attachmentDir);
      });

      await clearStatus();

      // Everything Claude said was already streamed via onText; the final
      // result is just the last assistant message again. Only send it if
      // nothing streamed (e.g. errors, timeouts, empty runs). A /stop cancel
      // was already acknowledged by the bridge command, so stay quiet.
      if (!res.cancelled && (!res.streamed || !res.ok)) {
        send(res.text);
      }
      // A slash command that only works in a real terminal — nudge the user
      // toward what the bridge can actually do.
      if (isInteractiveCommandMiss(userText, res.text)) {
        send(
          "ℹ️ That command needs a terminal. Send `/terminal` to open a live " +
            "interactive session and run it there, or `/help` for bridge commands."
        );
      }
      await sendQueue;
    } catch (err) {
      log.error("[discord] handler failed:", err);
      message.reply("Something went wrong handling that message.").catch(() => {});
    }
  });

  // Claude's multiple-choice questions -> Discord select menus.
  // Answers go back through the permission tool via updatedInput.answers.
  async function handleQuestion(channel, input) {
    const answers = {};
    for (const q of input.questions ?? []) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("answer")
        .setPlaceholder(q.header || "Choose an option")
        .setMinValues(1)
        .setMaxValues(q.multiSelect ? Math.min(q.options.length, 25) : 1)
        .addOptions(
          q.options.slice(0, 25).map((o) => ({
            label: o.label.slice(0, 100),
            description: (o.description || "").slice(0, 100),
            value: o.label.slice(0, 100),
          }))
        );
      const row = new ActionRowBuilder().addComponents(menu);
      const content = `❓ **${q.question}**`.slice(0, 2000);
      const msg = await channel.send({ content, components: [row] });

      const interaction = await msg
        .awaitMessageComponent({ time: config.approvals.timeoutMs })
        .catch(() => null);

      if (!interaction) {
        await msg
          .edit({ content: content + "\n⏱️ **Timed out.**", components: [] })
          .catch(() => {});
        return { allow: false, message: "The user did not answer in time." };
      }

      answers[q.question] = interaction.values.join(", ");
      await interaction
        .update({
          content: content + `\n➡️ **${answers[q.question]}** (${interaction.user.tag})`,
          components: [],
        })
        .catch(() => {});
    }
    return { allow: true, updatedInput: { ...input, answers } };
  }

  // Claude permission prompts -> Discord Allow/Deny buttons
  setPermissionHandler(async (sessionKey, { toolName, input }) => {
    const channelId = sessionKey.split(":")[1];
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { allow: false, message: "Could not find the Discord channel." };
    }

    // Questions get a picker, not Allow/Deny.
    if (toolName === "AskUserQuestion") {
      return handleQuestion(channel, input);
    }

    const { title, body } = formatPermission(toolName, input);
    const embed = new EmbedBuilder()
      .setColor(0xf5a623)
      .setAuthor({ name: "Permission request" })
      .setTitle(clip(title, 256))
      .setDescription(body ? clip(body, 4000) : null)
      .setFooter({
        text: `Auto-denies in ${Math.round(config.approvals.timeoutMs / 60000)} min`,
      });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("approve")
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("deny")
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });
    const interaction = await msg
      .awaitMessageComponent({ time: config.approvals.timeoutMs })
      .catch(() => null);

    const finish = (color, footerText) =>
      EmbedBuilder.from(embed).setColor(color).setFooter({ text: footerText });

    if (!interaction) {
      await msg.edit({
        embeds: [finish(0x99aab5, "⏱️ Timed out — denied")],
        components: [],
      }).catch(() => {});
      return { allow: false, message: "Approval timed out on Discord." };
    }

    const allow = interaction.customId === "approve";
    await interaction.update({
      embeds: [
        finish(
          allow ? 0x57f287 : 0xed4245,
          `${allow ? "✅ Allowed" : "❌ Denied"} by ${interaction.user.tag}`
        ),
      ],
      components: [],
    }).catch(() => {});

    return {
      allow,
      message: allow ? undefined : `Denied by ${interaction.user.tag} on Discord.`,
    };
  });

  client.once("clientReady", () => {
    log.info(`[discord] logged in as ${client.user.tag}`);
    log.info(
      `[discord] watching: ${
        allowedChannels.length ? allowedChannels.join(", ") : "all channels"
      } | mention required: ${requireMention}`
    );
  });

  // ── PR review loop ─────────────────────────────────────────────────────────
  // Wire the reviewer/author/thread hooks. Wrapped so any issue here can never
  // break message handling or startup.
  try {
    const reviewerKey = process.env.PR_REVIEWER_CHANNEL || "";

    const resolveReviewerChannel = () => {
      if (!reviewerKey) return null;
      return (
        client.channels.cache.get(reviewerKey) ||
        client.channels.cache.find(
          (c) => c?.name === reviewerKey && c?.isTextBased?.() && !c?.isThread?.()
        ) ||
        null
      );
    };

    // A serialized, chunked sender bound to one thread/channel.
    const senderFor = (target) => {
      let q = Promise.resolve();
      return (text) => {
        q = q
          .then(async () => {
            for (const part of chunk(String(text ?? ""))) {
              await target.send(part).catch(() => {});
            }
          })
          .catch(() => {});
        return q;
      };
    };

    const prThreads = new Map(); // prUrl -> thread (or fallback channel)

    registerPrReviewer({
      reviewer: () => {
        const ch = resolveReviewerChannel();
        if (!ch) return null;
        return {
          sessionKey: `discord:${ch.id}`,
          cwd: resolveProject({ channelId: ch.id, channelName: ch.name, isDM: false }),
        };
      },
      origin: (sessionKey) => {
        const id = String(sessionKey).split(":")[1];
        const ch = client.channels.cache.get(id);
        return {
          cwd: resolveProject({ channelId: id, channelName: ch?.name, isDM: false }),
        };
      },
      ensureThread: async (prUrl) => {
        let thread = prThreads.get(prUrl);
        if (!thread) {
          const parent = resolveReviewerChannel();
          const num = (prUrl.match(/\/pull\/(\d+)/) || [])[1];
          const name = (num ? `PR #${num}` : "PR review").slice(0, 90);
          thread =
            (await parent?.threads
              ?.create({ name, autoArchiveDuration: 1440 })
              .catch(() => null)) ||
            parent; // fall back to the channel if threads aren't available
          prThreads.set(prUrl, thread);
          await thread?.send(`🧵 ${prUrl}`).catch(() => {});
        }
        return senderFor(thread);
      },
      askMerge: async (_send, prUrl) => {
        const target = prThreads.get(prUrl) || resolveReviewerChannel();
        if (!target) return false;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("prmerge:yes")
            .setLabel("Merge")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("prmerge:no")
            .setLabel("Keep open")
            .setStyle(ButtonStyle.Secondary)
        );
        const msg = await target
          .send({ content: `Merge **${prUrl}**?`, components: [row] })
          .catch(() => null);
        if (!msg) return false;
        const i = await msg
          .awaitMessageComponent({ time: config.approvals.timeoutMs })
          .catch(() => null);
        if (!i) {
          await msg.edit({ content: `Merge **${prUrl}**? ⏱️ timed out`, components: [] }).catch(() => {});
          return false;
        }
        const yes = i.customId === "prmerge:yes";
        await i
          .update({
            content: `Merge **${prUrl}**? ${yes ? "✅ merging" : "❌ kept open"} (${i.user.tag})`,
            components: [],
          })
          .catch(() => {});
        return yes;
      },
    });
    log.info(
      `[pr] review loop ${reviewerKey ? `armed (channel: ${reviewerKey})` : "idle (PR_REVIEWER_CHANNEL unset)"}`
    );
  } catch (err) {
    log.error("[pr] failed to wire review loop:", err.message);
  }

  await client.login(token);
  return () => {
    termMod?.closeAllTerminals();
    client.destroy();
  };
}
