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

      if (
        allowedChannels.length &&
        !isDM &&
        !allowedChannels.includes(message.channelId)
      ) {
        return;
      }

      const mentioned = message.mentions.users.has(client.user.id);
      if (!isDM && requireMention && !mentioned) return;

      // Each channel maps to its own project directory (own CLAUDE.md,
      // .mcp.json, skills, and chat history).
      const projectDir = resolveProject({
        channelId: message.channelId,
        channelName: isDM ? null : message.channel.name,
        isDM,
      });
      if (!projectDir) return;

      // Strip the bot mention from the prompt
      const userText = message.content
        .replaceAll(`<@${client.user.id}>`, "")
        .trim();

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

      const sessionKey = `discord:${message.channelId}`;
      const res = await askClaude(sessionKey, prompt, projectDir, send, {
        addDirs,
      }).finally(() => {
        clearInterval(typing);
        cleanupAttachments(attachmentDir);
      });

      // Everything Claude said was already streamed via onText; the final
      // result is just the last assistant message again. Only send it if
      // nothing streamed (e.g. errors, timeouts, empty runs).
      if (!res.streamed || !res.ok) {
        send(res.text);
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

  await client.login(token);
  return () => client.destroy();
}
