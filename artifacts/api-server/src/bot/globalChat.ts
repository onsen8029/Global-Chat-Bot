import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  Events,
  PermissionFlagsBits,
  ActivityType,
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
  globalBansTable,
  userStatsTable,
} from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MESSAGES = 5;
const SPAM_BAN_DURATION_MS = 60_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

async function isPermanentlyBanned(userId: string): Promise<boolean> {
  const [ban] = await db
    .select()
    .from(globalBansTable)
    .where(eq(globalBansTable.userId, userId));
  return !!ban;
}

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
    const elapsed = now.getTime() - tracker.windowStart.getTime();

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

async function incrementUserStats(userId: string, userName: string): Promise<void> {
  await db
    .insert(userStatsTable)
    .values({ userId, userName, totalMessages: 1, lastSeen: new Date() })
    .onConflictDoUpdate({
      target: userStatsTable.userId,
      set: {
        userName,
        totalMessages: sql`${userStatsTable.totalMessages} + 1`,
        lastSeen: new Date(),
      },
    });
}

async function buildReplyHeader(originMessage: Message): Promise<string> {
  if (!originMessage.reference?.messageId) return "";

  try {
    const referenced = await originMessage.fetchReference();
    const refAuthor = referenced.author;
    const refContent = referenced.content
      ? referenced.content.slice(0, 80) + (referenced.content.length > 80 ? "…" : "")
      : referenced.attachments.size > 0
        ? "📎 添付ファイル"
        : "（メッセージなし）";

    const refName = refAuthor.bot
      ? refAuthor.displayName
      : `${refAuthor.displayName}`;

    return `> ↩️ **${refName}**: ${refContent}\n`;
  } catch {
    return "> ↩️ （返信元メッセージを取得できませんでした）\n";
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

  const stickerLines: string[] = [];
  for (const sticker of originMessage.stickers.values()) {
    stickerLines.push(`🏷️ **${sticker.name}**\n${sticker.url}`);
  }

  const username = `${originMessage.author.displayName} (${originMessage.guild?.name ?? "Unknown"})`;
  const avatarURL = originMessage.author.displayAvatarURL();
  const replyHeader = await buildReplyHeader(originMessage);

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

      let content = replyHeader;
      if (originMessage.content) {
        content += originMessage.content;
      }
      if (attachmentUrls.length > 0) {
        content += (content ? "\n" : "") + attachmentUrls.join("\n");
      }
      if (stickerLines.length > 0) {
        content += (content ? "\n" : "") + stickerLines.join("\n");
      }

      if (!content && embeds.length === 0) {
        continue;
      }

      if (content) payload.content = content;

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

function updateStatus(): void {
  const guildCount = client.guilds.cache.size;
  client.user?.setPresence({
    activities: [
      {
        name: `${guildCount} サーバーで稼働中`,
        type: ActivityType.Watching,
      },
    ],
    status: "online",
  });
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
    new SlashCommandBuilder()
      .setName("ランキング")
      .setDescription("グローバルチャットの発言数ランキングを表示します")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("インストール数")
      .setDescription("Botが導入されているサーバー数とグローバルチャットの統計を表示します")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("出禁")
      .setDescription("指定したユーザーをグローバルチャットから出禁にします（管理者のみ）")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((opt) =>
        opt.setName("ユーザー").setDescription("出禁にするユーザー").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("理由").setDescription("出禁の理由").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("出禁解除")
      .setDescription("指定したユーザーの出禁を解除します（管理者のみ）")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((opt) =>
        opt.setName("ユーザー").setDescription("出禁解除するユーザー").setRequired(true)
      )
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
    updateStatus();
    // 10分ごとにステータスを更新
    setInterval(updateStatus, 10 * 60 * 1000);
  });

  client.on(Events.GuildCreate, () => updateStatus());
  client.on(Events.GuildDelete, () => updateStatus());

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild || !interaction.channel) return;

    const commandName = interaction.commandName;

    // ========================
    // /グローバル開始
    // ========================
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

    // ========================
    // /グローバル終了
    // ========================
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

    // ========================
    // /インストール数
    // ========================
    if (commandName === "インストール数") {
      await interaction.deferReply();

      const guildCount = client.guilds.cache.size;
      const globalChannels = await db.select().from(globalChannelsTable);
      const globalGuildIds = new Set(globalChannels.map((c) => c.guildId));
      const [statsRow] = await db
        .select({ total: sql<number>`sum(${userStatsTable.totalMessages})` })
        .from(userStatsTable);
      const totalMessages = Number(statsRow?.total ?? 0);

      await interaction.editReply({
        embeds: [
          {
            title: "📊 Bot 統計情報",
            color: 0x5865f2,
            fields: [
              {
                name: "🏠 導入サーバー数",
                value: `${guildCount.toLocaleString()} サーバー`,
                inline: true,
              },
              {
                name: "🌐 グローバルチャット参加サーバー",
                value: `${globalGuildIds.size.toLocaleString()} サーバー`,
                inline: true,
              },
              {
                name: "📨 グローバルチャット総発言数",
                value: `${totalMessages.toLocaleString()} 件`,
                inline: true,
              },
            ],
            footer: { text: "リアルタイムデータ" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }

    // ========================
    // /ランキング
    // ========================
    if (commandName === "ランキング") {
      await interaction.deferReply();

      const top = await db
        .select()
        .from(userStatsTable)
        .orderBy(desc(userStatsTable.totalMessages))
        .limit(10);

      if (top.length === 0) {
        await interaction.editReply("まだグローバルチャットでの発言がありません。");
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      const lines = top.map((entry, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        return `${rank} **${entry.userName}** — ${entry.totalMessages.toLocaleString()} 件`;
      });

      await interaction.editReply({
        embeds: [
          {
            title: "🏆 グローバルチャット 発言数ランキング",
            description: lines.join("\n"),
            color: 0xf5a623,
            footer: { text: `全 ${top.length} 名を表示` },
          },
        ],
      });
    }

    // ========================
    // /出禁
    // ========================
    if (commandName === "出禁") {
      await interaction.deferReply({ ephemeral: true });

      const targetUser = interaction.options.getUser("ユーザー", true);
      const reason = interaction.options.getString("理由") ?? "理由なし";

      if (targetUser.bot) {
        await interaction.editReply("Botを出禁にすることはできません。");
        return;
      }

      const [existing] = await db
        .select()
        .from(globalBansTable)
        .where(eq(globalBansTable.userId, targetUser.id));

      if (existing) {
        await interaction.editReply(`**${targetUser.displayName}** はすでに出禁になっています。`);
        return;
      }

      await db.insert(globalBansTable).values({
        userId: targetUser.id,
        bannedByUserId: interaction.user.id,
        reason,
      });

      await interaction.editReply(
        `🚫 **${targetUser.displayName}** をグローバルチャットから出禁にしました。\n理由: ${reason}`
      );
      logger.info({ targetUserId: targetUser.id, bannedBy: interaction.user.id, reason }, "User banned from global chat");
    }

    // ========================
    // /出禁解除
    // ========================
    if (commandName === "出禁解除") {
      await interaction.deferReply({ ephemeral: true });

      const targetUser = interaction.options.getUser("ユーザー", true);

      const [existing] = await db
        .select()
        .from(globalBansTable)
        .where(eq(globalBansTable.userId, targetUser.id));

      if (!existing) {
        await interaction.editReply(`**${targetUser.displayName}** は出禁になっていません。`);
        return;
      }

      await db
        .delete(globalBansTable)
        .where(eq(globalBansTable.userId, targetUser.id));

      await interaction.editReply(
        `✅ **${targetUser.displayName}** の出禁を解除しました。`
      );
      logger.info({ targetUserId: targetUser.id, unbannedBy: interaction.user.id }, "User unbanned from global chat");
    }
  });

  // ========================
  // メッセージ受信
  // ========================
  client.on(Events.MessageCreate, async (message) => {
    if (!message.author) return;
    if (!message.guild) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, message.channelId));

    if (!globalChannel) return;

    // 自分のWebhookメッセージは無限ループ防止のためスキップ
    if (message.webhookId === globalChannel.webhookId) return;

    // 人間のユーザーのみ出禁・スパム・統計チェック
    if (!message.author.bot) {
      // 出禁チェック（メッセージは消さず、他サーバーへの転送のみスキップ）
      const banned = await isPermanentlyBanned(message.author.id);
      if (banned) return;

      // スパムチェック
      const spamming = await isSpamming(message.author.id);
      if (spamming) {
        try {
          await message.reply("⚠️ スパム検出: しばらく待ってからメッセージを送ってください。");
          await message.delete().catch(() => {});
        } catch (_) {}
        return;
      }

      // 統計更新
      await incrementUserStats(message.author.id, message.author.displayName);
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

  // ========================
  // メッセージ編集
  // ========================
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.author) return;
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

  // ========================
  // メッセージ削除
  // ========================
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

  // ========================
  // リアクション追加
  // ========================
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (!reaction.message.guild) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, reaction.message.channelId));
    if (!globalChannel) return;

    const mappings = await db
      .select()
      .from(globalMessageMappingsTable)
      .where(eq(globalMessageMappingsTable.originMessageId, reaction.message.id));

    const emoji = reaction.emoji.id
      ? `${reaction.emoji.animated ? "a" : ""}:${reaction.emoji.name}:${reaction.emoji.id}`
      : reaction.emoji.name!;

    for (const mapping of mappings) {
      try {
        const channel = await client.channels.fetch(mapping.channelId);
        if (!channel?.isTextBased()) continue;
        const msg = await (channel as TextChannel).messages.fetch(mapping.webhookMessageId);
        await msg.react(emoji);
      } catch (err) {
        logger.error({ err, channelId: mapping.channelId }, "Failed to mirror reaction");
      }
    }
  });

  // ========================
  // リアクション削除
  // ========================
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (!reaction.message.guild) return;

    // 同じ絵文字のリアクションがまだ残っている場合はミラーを維持
    if ((reaction.count ?? 1) > 0) return;

    const [globalChannel] = await db
      .select()
      .from(globalChannelsTable)
      .where(eq(globalChannelsTable.channelId, reaction.message.channelId));
    if (!globalChannel) return;

    const mappings = await db
      .select()
      .from(globalMessageMappingsTable)
      .where(eq(globalMessageMappingsTable.originMessageId, reaction.message.id));

    for (const mapping of mappings) {
      try {
        const channel = await client.channels.fetch(mapping.channelId);
        if (!channel?.isTextBased()) continue;
        const msg = await (channel as TextChannel).messages.fetch(mapping.webhookMessageId);
        const botReaction = msg.reactions.cache.find((r) =>
          reaction.emoji.id
            ? r.emoji.id === reaction.emoji.id
            : r.emoji.name === reaction.emoji.name
        );
        if (botReaction) await botReaction.users.remove(client.user!.id);
      } catch (err) {
        logger.error({ err, channelId: mapping.channelId }, "Failed to remove mirrored reaction");
      }
    }
  });

  await client.login(token);
}
