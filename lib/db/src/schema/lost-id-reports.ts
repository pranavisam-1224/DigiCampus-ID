import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const lostReportStatusEnum = pgEnum("lost_report_status", ["open", "resolved"]);

export const lostIdReportsTable = pgTable("lost_id_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentRecordId: uuid("student_record_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: lostReportStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LostIdReportRecord = typeof lostIdReportsTable.$inferSelect;
