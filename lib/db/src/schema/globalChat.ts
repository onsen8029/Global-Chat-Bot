import { pgTable, text, serial, timestamp, boolean, integer, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const globalChannelsTable = pgTable("global_channels", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  webhookId: text("webhook_id").notNull(),
  webhookToken: text("webhook_token").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const globalMessagesTable = pgTable("global_messages", {
  id: serial("id").primaryKey(),
  originMessageId: text("origin_message_id").notNull(),
  originChannelId: text("origin_channel_id").notNull(),
  originGuildId: text("origin_guild_id").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  content: text("content"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const globalMessageMappingsTable = pgTable("global_message_mappings", {
  id: serial("id").primaryKey(),
  originMessageId: text("origin_message_id").notNull(),
  webhookMessageId: text("webhook_message_id").notNull(),
  channelId: text("channel_id").notNull(),
  webhookId: text("webhook_id").notNull(),
  webhookToken: text("webhook_token").notNull(),
});

export const spamTrackerTable = pgTable("spam_tracker", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  messageCount: integer("message_count").default(0).notNull(),
  windowStart: timestamp("window_start").defaultNow().notNull(),
  isBanned: boolean("is_banned").default(false).notNull(),
  bannedUntil: timestamp("banned_until"),
});

export const globalBansTable = pgTable("global_bans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  bannedByUserId: text("banned_by_user_id").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userStatsTable = pgTable("user_stats", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  userName: text("user_name").notNull(),
  totalMessages: integer("total_messages").default(0).notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
});

export const insertGlobalChannelSchema = createInsertSchema(globalChannelsTable).omit({ id: true, createdAt: true });
export const insertGlobalMessageSchema = createInsertSchema(globalMessagesTable).omit({ id: true, createdAt: true });
export const insertGlobalMessageMappingSchema = createInsertSchema(globalMessageMappingsTable).omit({ id: true });
export const insertSpamTrackerSchema = createInsertSchema(spamTrackerTable).omit({ id: true });
export const insertGlobalBanSchema = createInsertSchema(globalBansTable).omit({ id: true, createdAt: true });
export const insertUserStatsSchema = createInsertSchema(userStatsTable).omit({ id: true });

export type GlobalChannel = typeof globalChannelsTable.$inferSelect;
export type GlobalMessage = typeof globalMessagesTable.$inferSelect;
export type GlobalMessageMapping = typeof globalMessageMappingsTable.$inferSelect;
export type SpamTracker = typeof spamTrackerTable.$inferSelect;
export type GlobalBan = typeof globalBansTable.$inferSelect;
export type UserStats = typeof userStatsTable.$inferSelect;
export type InsertGlobalChannel = z.infer<typeof insertGlobalChannelSchema>;
export type InsertGlobalMessage = z.infer<typeof insertGlobalMessageSchema>;
export type InsertGlobalBan = z.infer<typeof insertGlobalBanSchema>;
