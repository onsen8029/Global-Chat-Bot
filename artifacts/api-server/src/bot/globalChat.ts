import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  Events,
  type Message,
  type TextChannel,
  type MessageCreateOptions,
  type WebhookClient,
  type APIEmbed,
} from "discord.js";
import { WebhookClient as WebhookClientClass } from "discord.js";
import { db } from "@workspace/db";
import {
  globalChannelsTable,
  globalMessagesTable,
  globalMessageMappingsTable,
  spamTrackerTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MESSAGES = 5;
const SPAM_BAN_DURATION_MS = 60_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function isSpamming(userId: string): Promise<boolean> {
  const now = new Date();

  const [tracker] = await db
    .select()
    .from(spamTrackerTable)
    .where(eq(spamTrackerTable.userId, userId));

  if (tracker?.isBanned && tracker.bannedUntil && tracker.bannedUntil > now) {
    return true;
  }

  if (tracker) {
    const windowStart = tracker.windowStart;
    const elapsed = now.getTime() - windowStart.getTime();

    if (elapsed > SPAM_WINDOW_MS) {
      await db
        .update(spamTrackerTable)
        .set({ messageCount: 1, windowStart: now, isBanned: false, bannedUntil: null })
        .where(eq(spamTrackerTable.userId, userId));
      return false;
    }

    const newCount = tracker.messageCount + 1;
    if (newCount > SPAM_MAX_MESSAGES) {
      const bannedUntil = new Date(now.getTime() + SPAM_BAN_DURATION_MS);
      await db
        .update(spamTrackerTable)
        .set({ messageCount: newCount, isBanned: true, bannedUntil })
        .where(eq(spamTrackerTable.userId, userId));
      return true;
    }

    await db
      .update(spamTrackerTable)
      .set({ messageCount: newCount })
      .where(eq(spamTrackerTable.userId, userId));
    return false;
  } else {
    await db.insert(spamTrackerTable).values({
      userId,
      messageCount: 1,
      windowStart: now,
      isBanned: false,
    });
    return false;
  }
}

async function broadcastMessage(
  originMessage: Message,
  excludeChannelId: string
): Promise<void> {
  const channels = await db.select().from(globalChannelsTable);
  const targets = channels.filter((ch) => ch.channelId !== excludeChannelId);

  const embeds: APIEmbed[] = [];
  const attachmentUrls: string[] = [];

  for (const attachment of originMessage.attachments.values()) {
    attachmentUrls.push(attachment.url);
  }

  const username = `${originMessage.author.displayName} (${originMessage.guild?.name ?? "Unknown"})`;
  const avatarURL = originMessage.author.displayAvatarURL();

  for (const target of targets) {
    try {
      const webhookClient: WebhookClient = new WebhookClientClass({
        id: target.webhookId,
        token: target.webhookToken,
      });

      const payload: MessageCreateOptions & { username?: string; avatarURL?: string } = {
        username,
        avatarURL,
        allowedMentions: { parse: [] },
      };

      if (originMessage.content) {
        payload.content = originMessage.content;
      }

      if (attachmentUrls.length > 0) {
        payload.content = (payload.content ? payload.content + "\n" : "") + attachmentUrls.join("\n");
      }

      if (!payload.content && embeds.length === 0) {
        continue;
      }

      const sent = await webhookClient.send(payload as Parameters<typeof webhookClient.send>[0]);

      await db.insert(globalMessageMappingsTable).values({
        originMessageId: originMessage.id,
        webhookMessageId: sent.id,
        channelId: target.channelId,
        webhookId: target.webhookId,
        webhookToken: target.webhookToken,
      });
    } catch (err) {
      logger.error({ err, channelId: target.channelId }, "Failed to send to channel");
    }
  }
}

async function editBroadcastedMessages(
  originMessageId: string,
  newContent: string
): Promise<void> {
  const mappings = await db
    .select()
    .from(globalMessageMappingsTable)
    .where(eq(globalMessageMappingsTable.originMessageId, originMessageId));

  for (const mapping of mappings) {
    try {
      const webhookClient: WebhookClient = new WebhookClientClass({
        id: mapping.webhookId,
        token: mapping.webhookToken,
      });
      await webhookClient.editMessage(mapping.webhookMessageId, {
        content: `✏️ ${newContent}`,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.error({ err, channelId: mapping.channelId }, "Failed to edit message");
    }
  }
}

async function deleteBroadcastedMessages(originMessageId: string): Promise<void> {
  const mappings = await db
    .select()
    .from(globalMessageMappingsTable)
    .where(eq(globalMessageMappingsTable.originMessageId, originMessageId));

  for (const mapping of mappings) {
    try {
      const webhookClient: WebhookClient = new WebhookClientClass({
        id: mapping.webhookId,
        token: mapping.webhookToken,
      });
      await webhookClient.deleteMessage(mapping.webhookMessageId);
    } catch (err) {
      logger.error({ err, channelId: mapping.channelId }, "Failed to delete message");
    }
  }

  await db
    .delete(globalMessageMappingsTable)
    .where(eq(globalMessageMappingsTable.originMessageId, originMessageId));
}

async function registerCommands(token: string, clientId: string): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("グローバル開始")
      .setDescription("このチャンネルをグローバルチャットに登録します")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("グローバル終了")
      .setDescription("このチャンネルのグローバルチャット登録を解除します")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Slash commands registered globally");
}

export async function startBot(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is ready");
    await registerCommands(token, readyClient.user.id);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild || !interaction.channel) return;

    const commandName = interaction.commandName;

    if (commandName === "グローバル開始") {
      await interaction.deferReply({ ephemeral: true });

      const existing = await db
        .select()
        .from(globalChannelsTable)
        .where(eq(globalChannelsTable.channelId, interaction.channelId));

      if (existing.length > 0) {
        await interaction.editReply("このチャンネルはすでにグローバルチャットに登録されています。");
        return;
      }

      const channel = interaction.channel as TextChannel;
      if (channel.type !== ChannelType.GuildText) {
        await interaction.editReply("テキストチャンネルのみ登録できます。");
        return;
      }

      try {
        const webhook = await channel.createWebhook({
          name: "GlobalChat",
          reason: "グローバルチャット用Webhook",
        });

        await db.insert(globalChannelsTable).values({
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          webhookId: webhook.id,
          webhookToken: webhook.token!,
        });

        await interaction.editReply(
          "✅ このチャンネルをグローバルチャットに登録しました！\n他のサーバーのメッセージがここに表示されます。"
        );
        logger.info({ channelId: interaction.channelId, guildId: interaction.guildId }, "Global channel registered");
      } catch (err) {
        logger.error({ err }, "Failed to create webhook");
        await interaction.editReply("❌ Webhookの作成に失敗しました。Botに「Webhookの管理」権限があるか確認してください。");
      }
    }

    if (commandName === "グローバル終了") {
      await interaction.deferReply({ ephemeral: true });

      const [existing] = await db
        .select()
        .from(globalChannelsTable)
        .where(eq(globalChannelsTable.channelId, interaction.channelId));

      if (!existing) {
        await interaction.editReply("このチャンネルはグローバルチャットに登録されていません。");
        return;
      }

      try {
        const channel = interaction.channel as TextChannel;
        const webhooks = await channel.fetchWebhooks();
        const wh = webhooks.find((w) => w.id === existing.webhookId);
        if (wh) await wh.delete("グローバルチャット終了");
      } catch (_) {}

      await db
        .delete(globalChannelsTable)
        .where(eq(globalChannelsTable.channelId, interaction.channelId));

      await interaction.editReply("✅ このチャンネルのグローバルチャット登録を解除しました。");
      logger.info({ channelId: interaction.channelId }, "Global channel unregistered");
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, message.channelId));

    if (!globalChannel) return;

    const spamming = await isSpamming(message.author.id);
    if (spamming) {
      try {
        await message.reply("⚠️ スパム検出: しばらく待ってからメッセージを送ってください。");
        await message.delete().catch(() => {});
      } catch (_) {}
      return;
    }

    await db.insert(globalMessagesTable).values({
      originMessageId: message.id,
      originChannelId: message.channelId,
      originGuildId: message.guildId!,
      authorId: message.author.id,
      authorName: message.author.displayName,
      content: message.content || null,
    });

    await broadcastMessage(message, message.channelId);
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.author || newMessage.author.bot) return;
    if (!newMessage.guild) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, newMessage.channelId));

    if (!globalChannel) return;

    const newContent = newMessage.content || "";
    await editBroadcastedMessages(newMessage.id, newContent);

    await db
      .update(globalMessagesTable)
      .set({ content: newContent })
      .where(eq(globalMessagesTable.originMessageId, newMessage.id));
  });

  client.on(Events.MessageDelete, async (message) => {
    if (!message.guild) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, message.channelId));

    if (!globalChannel) return;

    await deleteBroadcastedMessages(message.id);

    await db
      .delete(globalMessagesTable)
      .where(eq(globalMessagesTable.originMessageId, message.id));
  });

  await client.login(token);
}
