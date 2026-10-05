import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const digitalIdStatusEnum = pgEnum("digital_id_status", [
  "active",
  "suspended",
  "revoked",
]);

export const digitalIdsTable = pgTable(
  "digital_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentRecordId: uuid("student_record_id").notNull().references(() => studentsTable.id),
    status: digitalIdStatusEnum("status").notNull().default("active"),
    tokenHash: text("token_hash").notNull().unique(),
    encryptedToken: text("encrypted_token").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("digital_ids_student_idx").on(table.studentRecordId)],
);

export type DigitalIdRecord = typeof digitalIdsTable.$inferSelect;
