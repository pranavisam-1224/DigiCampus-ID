import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const appRoleEnum = pgEnum("app_role", ["student", "verifier", "admin"]);
export const accountStatusEnum = pgEnum("account_status", [
  "unregistered",
  "pending",
  "active",
  "rejected",
  "suspended",
]);

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").unique(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: appRoleEnum("role").notNull().default("student"),
  status: accountStatusEnum("status").notNull().default("unregistered"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type User = typeof usersTable.$inferSelect;
