import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  CreateCorrectionRequestBody,
  CreateCorrectionRequestResponse,
  CreateLostReportBody,
  CreateLostReportResponse,
  CreateRegistrationBody,
  CreateRegistrationResponse,
  GetMeResponse,
  GetStudentDigitalIdResponse,
  GetStudentProfileResponse,
  GetStudentRequestsResponse,
  ListDepartmentsResponse,
  ListStudentVerificationsResponse,
  UpdateStudentProfileBody,
  UpdateStudentProfileResponse,
} from "@workspace/api-zod";
import {
  correctionRequestsTable,
  db,
  departmentsTable,
  digitalIdsTable,
  lostIdReportsTable,
  studentsTable,
  usersTable,
  verificationLogsTable,
} from "@workspace/db";
import {
  activeDigitalId,
  computedIdStatus,
  currentAccount,
  dateToISODate,
  decryptToken,
  getStudentForActor,
  HttpError,
  qrUrlForRequest,
  requireRole,
  requireSignedIn,
  seedDepartments,
  sendHttpError,
} from "../lib/campus";

const router: IRouter = Router();
const verifiedStudent = [requireSignedIn, requireRole("student")];

function safePhotoUrl(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "") return value;
  if (!value.startsWith("https://")) {
    throw new HttpError(400, "Profile photos must use a secure HTTPS URL.");
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

async function studentProfile(studentRecordId: string) {
  const [record] = await db
    .select({
      id: studentsTable.id,
      userId: studentsTable.userId,
      fullName: studentsTable.fullName,
      email: studentsTable.email,
      studentId: studentsTable.studentId,
      departmentId: departmentsTable.id,
      departmentName: departmentsTable.name,
      course: studentsTable.course,
      yearOfStudy: studentsTable.yearOfStudy,
      photoUrl: studentsTable.photoUrl,
      studentStatus: studentsTable.status,
      validityEnd: studentsTable.validityEnd,
    })
    .from(studentsTable)
    .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
    .where(eq(studentsTable.id, studentRecordId))
    .limit(1);
  if (!record) throw new HttpError(404, "Student profile not found.");
  const id = await activeDigitalId(record.id);
  const status =
    record.studentStatus === "active" && id
      ? computedIdStatus(id.status, id.expiresAt)
      : record.studentStatus;
  return {
    id: record.id,
    userId: record.userId,
    fullName: record.fullName,
    email: record.email,
    studentId: record.studentId,
    departmentId: record.departmentId,
    departmentName: record.departmentName,
    course: record.course,
    yearOfStudy: record.yearOfStudy,
    photoUrl: record.photoUrl,
    status,
  };
}

router.get("/departments", async (_req, res): Promise<void> => {
  try {
    await seedDepartments();
    const departments = await db
      .select({
        id: departmentsTable.id,
        name: departmentsTable.name,
        code: departmentsTable.code,
        isActive: departmentsTable.isActive,
      })
      .from(departmentsTable)
      .where(eq(departmentsTable.isActive, true))
      .orderBy(departmentsTable.name);
    res.json(ListDepartmentsResponse.parse(departments));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.get("/me", requireSignedIn, async (_req, res): Promise<void> => {
  try {
    res.json(GetMeResponse.parse(currentAccount(res.locals.actor)));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post("/registrations", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateRegistrationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = res.locals.actor;
  if (actor.status !== "unregistered") {
    res.status(409).json({ error: "This account already has a campus registration." });
    return;
  }

  const values = parsed.data;
  if (values.photoUrl) {
    try {
      safePhotoUrl(values.photoUrl);
    } catch (error) {
      sendHttpError(res, error);
      return;
    }
  }

  if (values.role === "student") {
    if (
      !values.studentId ||
      !values.departmentId ||
      !values.course ||
      !values.yearOfStudy ||
      !values.validityEnd
    ) {
      res.status(400).json({
        error: "Student ID, department, course, year, and ID validity date are required.",
      });
      return;
    }
    const [department] = await db
      .select()
      .from(departmentsTable)
      .where(and(eq(departmentsTable.id, values.departmentId), eq(departmentsTable.isActive, true)))
      .limit(1);
    if (!department) {
      res.status(400).json({ error: "Choose an active department." });
      return;
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(usersTable)
        .set({
          role: values.role,
          status: "pending",
          fullName: values.fullName.trim(),
        })
        .where(eq(usersTable.id, actor.id));
      if (values.role === "student") {
        await tx.insert(studentsTable).values({
          userId: actor.id,
          email: actor.email,
          fullName: values.fullName.trim(),
          studentId: values.studentId!.trim(),
          departmentId: values.departmentId!,
          course: values.course!.trim(),
          yearOfStudy: values.yearOfStudy!,
          photoUrl: safePhotoUrl(values.photoUrl) ?? null,
          validityEnd: dateToISODate(values.validityEnd!),
          status: "pending",
        });
      }
    });
    const [updated] = await db.select().from(usersTable).where(eq(usersTable.id, actor.id)).limit(1);
    res.status(201).json(CreateRegistrationResponse.parse(currentAccount(updated)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That student ID or email is already registered." });
      return;
    }
    sendHttpError(res, error);
  }
});

router.get("/student/profile", ...verifiedStudent, async (_req, res): Promise<void> => {
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
    res.json(GetStudentProfileResponse.parse(await studentProfile(student.id)));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.patch("/student/profile", ...verifiedStudent, async (req, res): Promise<void> => {
  const parsed = UpdateStudentProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
    await db
      .update(studentsTable)
      .set({
        ...(parsed.data.course !== undefined ? { course: parsed.data.course.trim() } : {}),
        ...(parsed.data.yearOfStudy !== undefined ? { yearOfStudy: parsed.data.yearOfStudy } : {}),
        ...(parsed.data.photoUrl !== undefined
          ? { photoUrl: safePhotoUrl(parsed.data.photoUrl) ?? null }
          : {}),
      })
      .where(eq(studentsTable.id, student.id));
    res.json(UpdateStudentProfileResponse.parse(await studentProfile(student.id)));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.get("/student/digital-id", ...verifiedStudent, async (req, res): Promise<void> => {
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
    const id = await activeDigitalId(student.id);
    if (!id) {
      res.status(404).json({ error: "No digital ID has been issued yet." });
      return;
    }
    const token = decryptToken(id.encryptedToken);
    const profile = await studentProfile(student.id);
    res.json(
      GetStudentDigitalIdResponse.parse({
        id: id.id,
        studentId: student.studentId,
        fullName: student.fullName,
        email: student.email,
        departmentName: profile.departmentName,
        course: student.course,
        yearOfStudy: student.yearOfStudy,
        photoUrl: student.photoUrl,
        status: computedIdStatus(id.status, id.expiresAt),
        issuedAt: id.issuedAt,
        expiresAt: id.expiresAt,
        qrUrl: qrUrlForRequest(req, token),
      }),
    );
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.get("/student/verifications", ...verifiedStudent, async (_req, res): Promise<void> => {
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
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
      .where(eq(verificationLogsTable.studentRecordId, student.id))
      .orderBy(desc(verificationLogsTable.createdAt))
      .limit(50);
    res.json(ListStudentVerificationsResponse.parse(rows));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.get("/student/requests", ...verifiedStudent, async (_req, res): Promise<void> => {
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
    const [lostReports, corrections] = await Promise.all([
      db
        .select({
          id: lostIdReportsTable.id,
          reason: lostIdReportsTable.reason,
          status: lostIdReportsTable.status,
          createdAt: lostIdReportsTable.createdAt,
        })
        .from(lostIdReportsTable)
        .where(eq(lostIdReportsTable.studentRecordId, student.id))
        .orderBy(desc(lostIdReportsTable.createdAt)),
      db
        .select({
          id: correctionRequestsTable.id,
          field: correctionRequestsTable.field,
          requestedValue: correctionRequestsTable.requestedValue,
          reason: correctionRequestsTable.reason,
          status: correctionRequestsTable.status,
          createdAt: correctionRequestsTable.createdAt,
        })
        .from(correctionRequestsTable)
        .where(eq(correctionRequestsTable.studentRecordId, student.id))
        .orderBy(desc(correctionRequestsTable.createdAt)),
    ]);
    res.json(GetStudentRequestsResponse.parse({ lostReports, corrections }));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post("/student/lost-reports", ...verifiedStudent, async (req, res): Promise<void> => {
  const parsed = CreateLostReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const student = await getStudentForActor(res.locals.actor);
    if (!student) {
      res.status(404).json({ error: "Student profile not found." });
      return;
    }
    const [report] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(lostIdReportsTable)
        .values({ studentRecordId: student.id, reason: parsed.data.reason.trim() })
        .returning();
      await tx
        .update(digitalIdsTable)
        .set({ status: "suspended" })
        .where(
          and(
            eq(digitalIdsTable.studentRecordId, student.id),
            eq(digitalIdsTable.status, "active"),
          ),
        );
      await tx
        .update(studentsTable)
        .set({ status: "suspended" })
        .where(eq(studentsTable.id, student.id));
      return inserted;
    });
    res.status(201).json(CreateLostReportResponse.parse(report));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post(
  "/student/correction-requests",
  ...verifiedStudent,
  async (req, res): Promise<void> => {
    const parsed = CreateCorrectionRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const student = await getStudentForActor(res.locals.actor);
      if (!student) {
        res.status(404).json({ error: "Student profile not found." });
        return;
      }
      const [request] = await db
        .insert(correctionRequestsTable)
        .values({
          studentRecordId: student.id,
          field: parsed.data.field,
          requestedValue: parsed.data.requestedValue.trim(),
          reason: parsed.data.reason.trim(),
        })
        .returning({
          id: correctionRequestsTable.id,
          field: correctionRequestsTable.field,
          requestedValue: correctionRequestsTable.requestedValue,
          reason: correctionRequestsTable.reason,
          status: correctionRequestsTable.status,
          createdAt: correctionRequestsTable.createdAt,
        });
      res.status(201).json(CreateCorrectionRequestResponse.parse(request));
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

export default router;
