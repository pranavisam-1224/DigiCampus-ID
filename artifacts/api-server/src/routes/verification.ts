import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  GetVerifierSummaryResponse,
  ListVerificationLogsResponse,
  ListVerificationLogsQueryParams,
  VerifyQrTokenBody,
  VerifyQrTokenResponse,
  VerifyStudentIdBody,
  VerifyStudentIdResponse,
} from "@workspace/api-zod";
import {
  db,
  departmentsTable,
  digitalIdsTable,
  studentsTable,
  usersTable,
  verificationLogsTable,
} from "@workspace/db";
import {
  computedIdStatus,
  hashToken,
  requireRole,
  requireSignedIn,
  sendHttpError,
} from "../lib/campus";

const router: IRouter = Router();
const verifyRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Wait a minute before verifying again." },
});

type VerificationStatus = "verified" | "invalid" | "suspended" | "expired" | "revoked";

function makeResult(
  result: VerificationStatus,
  student?: {
    fullName: string;
    studentId: string;
    departmentName: string;
    course: string;
    yearOfStudy: number;
    expiresAt: string;
  },
) {
  return {
    result,
    checkedAt: new Date(),
    studentName: student?.fullName ?? null,
    studentId: student?.studentId ?? null,
    departmentName: student?.departmentName ?? null,
    course: result === "verified" ? student?.course ?? null : null,
    yearOfStudy: result === "verified" ? student?.yearOfStudy ?? null : null,
    expiresAt: student?.expiresAt ?? null,
  };
}

function statusForStudent(
  studentStatus: "pending" | "active" | "suspended" | "revoked",
  idStatus: "active" | "suspended" | "revoked" | undefined,
  expiresAt: string | undefined,
): VerificationStatus {
  if (!idStatus || !expiresAt || studentStatus === "pending") return "invalid";
  if (studentStatus === "revoked" || idStatus === "revoked") return "revoked";
  if (studentStatus === "suspended" || idStatus === "suspended") return "suspended";
  return computedIdStatus(idStatus, expiresAt) === "expired" ? "expired" : "verified";
}

async function saveLog(options: {
  verifierUserId: string;
  method: "qr" | "manual";
  result: VerificationStatus;
  studentRecordId?: string | null;
  tokenFingerprint?: string | null;
  attemptedStudentId?: string | null;
}) {
  await db.insert(verificationLogsTable).values({
    verifierUserId: options.verifierUserId,
    method: options.method,
    result: options.result,
    studentRecordId: options.studentRecordId ?? null,
    tokenFingerprint: options.tokenFingerprint ?? null,
    attemptedStudentId: options.attemptedStudentId ?? null,
  });
}

router.post(
  "/verifications/qr",
  requireSignedIn,
  requireRole("verifier"),
  verifyRateLimit,
  async (req, res): Promise<void> => {
    const parsed = VerifyQrTokenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const fingerprint = hashToken(parsed.data.token);
    try {
      const [record] = await db
        .select({
          digitalIdId: digitalIdsTable.id,
          digitalIdStatus: digitalIdsTable.status,
          expiresAt: digitalIdsTable.expiresAt,
          studentRecordId: studentsTable.id,
          studentStatus: studentsTable.status,
          fullName: studentsTable.fullName,
          studentId: studentsTable.studentId,
          departmentName: departmentsTable.name,
          course: studentsTable.course,
          yearOfStudy: studentsTable.yearOfStudy,
        })
        .from(digitalIdsTable)
        .innerJoin(studentsTable, eq(digitalIdsTable.studentRecordId, studentsTable.id))
        .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
        .where(eq(digitalIdsTable.tokenHash, fingerprint))
        .limit(1);

      if (!record) {
        const result = makeResult("invalid");
        await saveLog({
          verifierUserId: res.locals.actor.id,
          method: "qr",
          result: "invalid",
          tokenFingerprint: fingerprint,
        });
        res.json(VerifyQrTokenResponse.parse(result));
        return;
      }

      const status = statusForStudent(
        record.studentStatus,
        record.digitalIdStatus,
        record.expiresAt,
      );
      const student = {
        fullName: record.fullName,
        studentId: record.studentId,
        departmentName: record.departmentName,
        course: record.course,
        yearOfStudy: record.yearOfStudy,
        expiresAt: record.expiresAt,
      };
      const result = makeResult(status, student);
      await saveLog({
        verifierUserId: res.locals.actor.id,
        method: "qr",
        result: status,
        studentRecordId: record.studentRecordId,
        tokenFingerprint: fingerprint,
      });
      res.json(VerifyQrTokenResponse.parse(result));
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.post(
  "/verifications/manual",
  requireSignedIn,
  requireRole("verifier"),
  verifyRateLimit,
  async (req, res): Promise<void> => {
    const parsed = VerifyStudentIdBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const [record] = await db
        .select({
          studentRecordId: studentsTable.id,
          studentStatus: studentsTable.status,
          fullName: studentsTable.fullName,
          studentId: studentsTable.studentId,
          departmentName: departmentsTable.name,
          course: studentsTable.course,
          yearOfStudy: studentsTable.yearOfStudy,
        })
        .from(studentsTable)
        .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
        .where(sql`lower(${studentsTable.studentId}) = lower(${parsed.data.studentId.trim()})`)
        .limit(1);

      if (!record) {
        const result = makeResult("invalid");
        await saveLog({
          verifierUserId: res.locals.actor.id,
          method: "manual",
          result: "invalid",
          attemptedStudentId: parsed.data.studentId.trim(),
        });
        res.json(VerifyStudentIdResponse.parse(result));
        return;
      }

      const [id] = await db
        .select({
          status: digitalIdsTable.status,
          expiresAt: digitalIdsTable.expiresAt,
        })
        .from(digitalIdsTable)
        .where(eq(digitalIdsTable.studentRecordId, record.studentRecordId))
        .orderBy(desc(digitalIdsTable.issuedAt))
        .limit(1);
      const status = statusForStudent(record.studentStatus, id?.status, id?.expiresAt);
      const result = makeResult(status, {
        fullName: record.fullName,
        studentId: record.studentId,
        departmentName: record.departmentName,
        course: record.course,
        yearOfStudy: record.yearOfStudy,
        expiresAt: id?.expiresAt ?? "",
      });
      await saveLog({
        verifierUserId: res.locals.actor.id,
        method: "manual",
        result: status,
        studentRecordId: record.studentRecordId,
        attemptedStudentId: parsed.data.studentId.trim(),
      });
      res.json(VerifyStudentIdResponse.parse(result));
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.get(
  "/verifier/summary",
  requireSignedIn,
  requireRole("verifier"),
  async (_req, res): Promise<void> => {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const [todayTotal] = await db
        .select({ value: count() })
        .from(verificationLogsTable)
        .where(
          and(
            eq(verificationLogsTable.verifierUserId, res.locals.actor.id),
            gte(verificationLogsTable.createdAt, today),
          ),
        );
      const [success] = await db
        .select({ value: count() })
        .from(verificationLogsTable)
        .where(
          and(
            eq(verificationLogsTable.verifierUserId, res.locals.actor.id),
            eq(verificationLogsTable.result, "verified"),
            gte(verificationLogsTable.createdAt, today),
          ),
        );
      const [failed] = await db
        .select({ value: count() })
        .from(verificationLogsTable)
        .where(
          and(
            eq(verificationLogsTable.verifierUserId, res.locals.actor.id),
            sql`${verificationLogsTable.result} <> 'verified'`,
            gte(verificationLogsTable.createdAt, today),
          ),
        );
      const recent = await db
        .select({
          id: verificationLogsTable.id,
          result: verificationLogsTable.result,
          method: verificationLogsTable.method,
          studentName: studentsTable.fullName,
          studentId: studentsTable.studentId,
          departmentName: departmentsTable.name,
          verifierName: usersTable.fullName,
          createdAt: verificationLogsTable.createdAt,
        })
        .from(verificationLogsTable)
        .leftJoin(studentsTable, eq(verificationLogsTable.studentRecordId, studentsTable.id))
        .leftJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
        .leftJoin(usersTable, eq(verificationLogsTable.verifierUserId, usersTable.id))
        .where(eq(verificationLogsTable.verifierUserId, res.locals.actor.id))
        .orderBy(desc(verificationLogsTable.createdAt))
        .limit(10);
      res.json(
        GetVerifierSummaryResponse.parse({
          todayTotal: todayTotal.value,
          successfulToday: success.value,
          failedToday: failed.value,
          recent,
        }),
      );
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.get(
  "/admin/verifications",
  requireSignedIn,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const parsed = ListVerificationLogsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const rows = await db
        .select({
          id: verificationLogsTable.id,
          result: verificationLogsTable.result,
          method: verificationLogsTable.method,
          studentName: studentsTable.fullName,
          studentId: studentsTable.studentId,
          departmentName: departmentsTable.name,
          verifierName: usersTable.fullName,
          createdAt: verificationLogsTable.createdAt,
        })
        .from(verificationLogsTable)
        .leftJoin(studentsTable, eq(verificationLogsTable.studentRecordId, studentsTable.id))
        .leftJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
        .leftJoin(usersTable, eq(verificationLogsTable.verifierUserId, usersTable.id))
        .orderBy(desc(verificationLogsTable.createdAt))
        .limit(parsed.data.limit ?? 50);
      res.json(ListVerificationLogsResponse.parse(rows));
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

export default router;
