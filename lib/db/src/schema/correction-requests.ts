import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const correctionStatusEnum = pgEnum("correction_status", [
  "pending",
  "approved",
  "rejected",
]);

export const correctionRequestsTable = pgTable("correction_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentRecordId: uuid("student_record_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  requestedValue: text("requested_value").notNull(),
  reason: text("reason").notNull(),
  status: correctionStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CorrectionRequestRecord = typeof correctionRequestsTable.$inferSelect;
