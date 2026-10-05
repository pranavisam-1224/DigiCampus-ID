import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const departmentsTable = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  code: text("code").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Department = typeof departmentsTable.$inferSelect;
