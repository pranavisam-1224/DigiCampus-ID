import { integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { departmentsTable } from "./departments";
import { usersTable } from "./users";

export const studentStatusEnum = pgEnum("student_status", [
  "pending",
  "active",
  "suspended",
  "revoked",
]);

export const studentsTable = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    email: text("email").notNull().unique(),
    fullName: text("full_name").notNull(),
    studentId: text("student_id").notNull().unique(),
    departmentId: uuid("department_id").notNull().references(() => departmentsTable.id),
    course: text("course").notNull(),
    yearOfStudy: integer("year_of_study").notNull(),
    photoUrl: text("photo_url"),
    status: studentStatusEnum("status").notNull().default("pending"),
    validityEnd: text("validity_end").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [unique("students_user_id_unique").on(table.userId)],
);

export type Student = typeof studentsTable.$inferSelect;
