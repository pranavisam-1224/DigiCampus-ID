import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";
import { usersTable } from "./users";

export const verificationResultEnum = pgEnum("verification_result", [
  "verified",
  "invalid",
  "suspended",
  "expired",
  "revoked",
]);
export const verificationMethodEnum = pgEnum("verification_method", ["qr", "manual"]);

export const verificationLogsTable = pgTable("verification_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentRecordId: uuid("student_record_id").references(() => studentsTable.id, { onDelete: "set null" }),
  verifierUserId: uuid("verifier_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  result: verificationResultEnum("result").notNull(),
  method: verificationMethodEnum("method").notNull(),
  tokenFingerprint: text("token_fingerprint"),
  attemptedStudentId: text("attempted_student_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationLogRecord = typeof verificationLogsTable.$inferSelect;
