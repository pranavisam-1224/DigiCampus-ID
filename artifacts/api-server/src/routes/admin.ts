import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import {
  CreateDepartmentBody,
  CreateDepartmentResponse,
  CreateStudentBody,
  CreateStudentResponse,
  DecideRegistrationBody,
  DecideRegistrationParams,
  DecideRegistrationResponse,
  GetAdminSummaryResponse,
  ListAdminDepartmentsResponse,
  ListAdminRequestsResponse,
  ListRegistrationsResponse,
  ListStudentsQueryParams,
  ListStudentsResponse,
  ListVerificationLogsResponse,
  ReissueDigitalIdParams,
  ReissueDigitalIdResponse,
  UpdateDepartmentBody,
  UpdateDepartmentParams,
  UpdateDepartmentResponse,
  UpdateDigitalIdStatusBody,
  UpdateDigitalIdStatusParams,
  UpdateDigitalIdStatusResponse,
  UpdateStudentBody,
  UpdateStudentParams,
  UpdateStudentResponse,
} from "@workspace/api-zod";
import type { AdminRequests } from "@workspace/api-zod";
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
  computedIdStatus,
  createQrToken,
  dateToISODate,
  decryptToken,
  encryptToken,
  hashToken,
  HttpError,
  issueDigitalId,
  qrUrlForRequest,
  requireRole,
  requireSignedIn,
  seedDepartments,
  sendHttpError,
} from "../lib/campus";

const router: IRouter = Router();
const adminOnly = [requireSignedIn, requireRole("admin")];

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function safePhotoUrl(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "") return value;
  if (!value.startsWith("https://")) {
    throw new HttpError(400, "Profile photos must use a secure HTTPS URL.");
  }
  return value;
}

async function studentRecord(studentId: string) {
  const [row] = await db
    .select({
      id: studentsTable.id,
      userId: studentsTable.userId,
      fullName: studentsTable.fullName,
      email: studentsTable.email,
      studentId: studentsTable.studentId,
      departmentId: studentsTable.departmentId,
      departmentName: departmentsTable.name,
      course: studentsTable.course,
      yearOfStudy: studentsTable.yearOfStudy,
      photoUrl: studentsTable.photoUrl,
      studentStatus: studentsTable.status,
      validityEnd: studentsTable.validityEnd,
    })
    .from(studentsTable)
    .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
    .where(eq(studentsTable.id, studentId))
    .limit(1);
  if (!row) return undefined;
  const [id] = await db
    .select()
    .from(digitalIdsTable)
    .where(eq(digitalIdsTable.studentRecordId, row.id))
    .orderBy(desc(digitalIdsTable.issuedAt))
    .limit(1);
  const idStatus = id ? computedIdStatus(id.status, id.expiresAt) : null;
  const status = row.studentStatus === "active" && idStatus ? idStatus : row.studentStatus;
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    email: row.email,
    studentId: row.studentId,
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    course: row.course,
    yearOfStudy: row.yearOfStudy,
    photoUrl: row.photoUrl,
    status,
    idStatus,
  };
}

async function digitalIdView(
  req: Parameters<typeof qrUrlForRequest>[0],
  id: typeof digitalIdsTable.$inferSelect,
) {
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      fullName: studentsTable.fullName,
      email: studentsTable.email,
      course: studentsTable.course,
      yearOfStudy: studentsTable.yearOfStudy,
      photoUrl: studentsTable.photoUrl,
      departmentName: departmentsTable.name,
    })
    .from(studentsTable)
    .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
    .where(eq(studentsTable.id, id.studentRecordId))
    .limit(1);
  if (!student) throw new HttpError(404, "Student record not found.");
  const rawToken = decryptToken(id.encryptedToken);
  return {
    id: id.id,
    studentId: student.studentId,
    fullName: student.fullName,
    email: student.email,
    departmentName: student.departmentName,
    course: student.course,
    yearOfStudy: student.yearOfStudy,
    photoUrl: student.photoUrl,
    status: computedIdStatus(id.status, id.expiresAt),
    issuedAt: id.issuedAt,
    expiresAt: id.expiresAt,
    qrUrl: qrUrlForRequest(req, rawToken),
  };
}

async function listStudentRecords(params: { search?: string; status?: string }) {
  const term = params.search?.trim();
  const records = await db
    .select({
      id: studentsTable.id,
      userId: studentsTable.userId,
      fullName: studentsTable.fullName,
      email: studentsTable.email,
      studentId: studentsTable.studentId,
      departmentId: studentsTable.departmentId,
      departmentName: departmentsTable.name,
      course: studentsTable.course,
      yearOfStudy: studentsTable.yearOfStudy,
      photoUrl: studentsTable.photoUrl,
      studentStatus: studentsTable.status,
    })
    .from(studentsTable)
    .innerJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
    .where(
      term
        ? or(
            ilike(studentsTable.fullName, `%${term}%`),
            ilike(studentsTable.email, `%${term}%`),
            ilike(studentsTable.studentId, `%${term}%`),
            ilike(departmentsTable.name, `%${term}%`),
          )
        : undefined,
    )
    .orderBy(studentsTable.fullName);
  const ids = await db
    .select()
    .from(digitalIdsTable)
    .orderBy(desc(digitalIdsTable.issuedAt));
  const latestByStudent = new Map<string, (typeof ids)[number]>();
  for (const id of ids) {
    if (!latestByStudent.has(id.studentRecordId)) latestByStudent.set(id.studentRecordId, id);
  }
  return records
    .map((row) => {
      const id = latestByStudent.get(row.id);
      const idStatus = id ? computedIdStatus(id.status, id.expiresAt) : null;
      const status = row.studentStatus === "active" && idStatus ? idStatus : row.studentStatus;
      return {
        id: row.id,
        userId: row.userId,
        fullName: row.fullName,
        email: row.email,
        studentId: row.studentId,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        course: row.course,
        yearOfStudy: row.yearOfStudy,
        photoUrl: row.photoUrl,
        status,
        idStatus,
      };
    })
    .filter((student) => !params.status || params.status === "all" || student.status === params.status);
}

async function registrationView(userId: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return undefined;
  const [student] = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      course: studentsTable.course,
      yearOfStudy: studentsTable.yearOfStudy,
      departmentName: departmentsTable.name,
    })
    .from(studentsTable)
    .leftJoin(departmentsTable, eq(studentsTable.departmentId, departmentsTable.id))
    .where(eq(studentsTable.userId, userId))
    .limit(1);
  return {
    userId: user.id,
    studentRecordId: student?.id ?? null,
    role: user.role,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    submittedAt: user.createdAt,
    departmentName: student?.departmentName ?? null,
    studentId: student?.studentId ?? null,
    course: student?.course ?? null,
    yearOfStudy: student?.yearOfStudy ?? null,
  };
}

router.get("/admin/summary", ...adminOnly, async (_req, res): Promise<void> => {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [[studentCount], [activeIdCount], [pendingCount], [failedCount], [verificationCount]] =
      await Promise.all([
        db.select({ value: count() }).from(studentsTable),
        db
          .select({ value: count() })
          .from(digitalIdsTable)
          .where(
            and(
              eq(digitalIdsTable.status, "active"),
              gte(digitalIdsTable.expiresAt, new Date().toISOString().slice(0, 10)),
            ),
          ),
        db
          .select({ value: count() })
          .from(usersTable)
          .where(eq(usersTable.status, "pending")),
        db
          .select({ value: count() })
          .from(verificationLogsTable)
          .where(
            and(
              sql`${verificationLogsTable.result} <> 'verified'`,
              gte(verificationLogsTable.createdAt, today),
            ),
          ),
        db.select({ value: count() }).from(verificationLogsTable),
      ]);
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
      .orderBy(desc(verificationLogsTable.createdAt))
      .limit(8);
    res.json(
      GetAdminSummaryResponse.parse({
        totalStudents: studentCount.value,
        activeIds: activeIdCount.value,
        pendingApprovals: pendingCount.value,
        failedVerificationsToday: failedCount.value,
        totalVerifications: verificationCount.value,
        recent,
      }),
    );
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.get("/admin/registrations", ...adminOnly, async (_req, res): Promise<void> => {
  try {
    const pending = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.status, "pending"))
      .orderBy(desc(usersTable.createdAt));
    const registrations = await Promise.all(pending.map(({ id }) => registrationView(id)));
    res.json(ListRegistrationsResponse.parse(registrations.filter(Boolean)));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post(
  "/admin/registrations/:userId/decision",
  ...adminOnly,
  async (req, res): Promise<void> => {
    const params = DecideRegistrationParams.safeParse(req.params);
    const body = DecideRegistrationBody.safeParse(req.body);
    if (!params.success || !body.success) {
      const message = !params.success
        ? params.error.message
        : !body.success
          ? body.error.message
          : "Invalid request.";
      res.status(400).json({ error: message });
      return;
    }
    try {
      const [pending] = await db
        .select()
        .from(usersTable)
        .where(and(eq(usersTable.id, params.data.userId), eq(usersTable.status, "pending")))
        .limit(1);
      if (!pending) {
        res.status(404).json({ error: "Pending registration not found." });
        return;
      }
      await db.transaction(async (tx) => {
        const nextStatus = body.data.decision === "approve" ? "active" : "rejected";
        await tx
          .update(usersTable)
          .set({ status: nextStatus })
          .where(eq(usersTable.id, pending.id));
        const [student] = await tx
          .select()
          .from(studentsTable)
          .where(eq(studentsTable.userId, pending.id))
          .limit(1);
        if (student) {
          await tx
            .update(studentsTable)
            .set({ status: body.data.decision === "approve" ? "active" : "pending" })
            .where(eq(studentsTable.id, student.id));
          if (body.data.decision === "approve") {
            const [existing] = await tx
              .select({ id: digitalIdsTable.id })
              .from(digitalIdsTable)
              .where(
                and(
                  eq(digitalIdsTable.studentRecordId, student.id),
                  eq(digitalIdsTable.status, "active"),
                ),
              )
              .limit(1);
            if (!existing) await issueDigitalId(student.id, student.validityEnd, tx);
          }
        }
      });
      res.json(
        DecideRegistrationResponse.parse(
          await registrationView(pending.id),
        ),
      );
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.get("/admin/students", ...adminOnly, async (req, res): Promise<void> => {
  const parsed = ListStudentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(ListStudentsResponse.parse(await listStudentRecords(parsed.data)));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post("/admin/students", ...adminOnly, async (req, res): Promise<void> => {
  const parsed = CreateStudentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  if (input.photoUrl) {
    try {
      safePhotoUrl(input.photoUrl);
    } catch (error) {
      sendHttpError(res, error);
      return;
    }
  }
  const email = input.email.trim().toLocaleLowerCase();
  const [department] = await db
    .select()
    .from(departmentsTable)
    .where(and(eq(departmentsTable.id, input.departmentId), eq(departmentsTable.isActive, true)))
    .limit(1);
  if (!department) {
    res.status(400).json({ error: "Choose an active department." });
    return;
  }
  try {
    const studentId = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      let userId: string;
      if (existingUser) {
        if (existingUser.status !== "unregistered" && existingUser.role !== "student") {
          throw new HttpError(409, "That email already belongs to an active campus account.");
        }
        const [updated] = await tx
          .update(usersTable)
          .set({ role: "student", status: "active", fullName: input.fullName.trim() })
          .where(eq(usersTable.id, existingUser.id))
          .returning({ id: usersTable.id });
        userId = updated.id;
      } else {
        const [created] = await tx
          .insert(usersTable)
          .values({
            email,
            fullName: input.fullName.trim(),
            role: "student",
            status: "active",
          })
          .returning({ id: usersTable.id });
        userId = created.id;
      }
      const [student] = await tx
        .insert(studentsTable)
        .values({
          userId,
          email,
          fullName: input.fullName.trim(),
          studentId: input.studentId.trim(),
          departmentId: input.departmentId,
          course: input.course.trim(),
          yearOfStudy: input.yearOfStudy,
          photoUrl: safePhotoUrl(input.photoUrl) ?? null,
          validityEnd: dateToISODate(input.validityEnd),
          status: "active",
        })
        .returning({ id: studentsTable.id });
      await issueDigitalId(student.id, dateToISODate(input.validityEnd), tx);
      return student.id;
    });
    const created = await studentRecord(studentId);
    res.status(201).json(CreateStudentResponse.parse(created));
  } catch (error) {
    if (error instanceof HttpError) {
      sendHttpError(res, error);
      return;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That email or student ID is already in use." });
      return;
    }
    sendHttpError(res, error);
  }
});

router.patch(
  "/admin/students/:studentId",
  ...adminOnly,
  async (req, res): Promise<void> => {
    const params = UpdateStudentParams.safeParse(req.params);
    const body = UpdateStudentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      const message = !params.success
        ? params.error.message
        : !body.success
          ? body.error.message
          : "Invalid request.";
      res.status(400).json({ error: message });
      return;
    }
    try {
      const existing = await studentRecord(params.data.studentId);
      if (!existing) {
        res.status(404).json({ error: "Student not found." });
        return;
      }
      if (body.data.departmentId) {
        const [department] = await db
          .select()
          .from(departmentsTable)
          .where(and(eq(departmentsTable.id, body.data.departmentId), eq(departmentsTable.isActive, true)))
          .limit(1);
        if (!department) {
          res.status(400).json({ error: "Choose an active department." });
          return;
        }
      }
      await db.transaction(async (tx) => {
        await tx
          .update(studentsTable)
          .set({
            ...(body.data.fullName !== undefined ? { fullName: body.data.fullName.trim() } : {}),
            ...(body.data.studentId !== undefined ? { studentId: body.data.studentId.trim() } : {}),
            ...(body.data.departmentId !== undefined ? { departmentId: body.data.departmentId } : {}),
            ...(body.data.course !== undefined ? { course: body.data.course.trim() } : {}),
            ...(body.data.yearOfStudy !== undefined ? { yearOfStudy: body.data.yearOfStudy } : {}),
            ...(body.data.photoUrl !== undefined
              ? { photoUrl: safePhotoUrl(body.data.photoUrl) ?? null }
              : {}),
            ...(body.data.validityEnd !== undefined
              ? { validityEnd: dateToISODate(body.data.validityEnd) }
              : {}),
          })
          .where(eq(studentsTable.id, params.data.studentId));
        if (body.data.fullName !== undefined && existing.userId) {
          await tx
            .update(usersTable)
            .set({ fullName: body.data.fullName.trim() })
            .where(eq(usersTable.id, existing.userId));
        }
        if (body.data.validityEnd !== undefined) {
          const [latestId] = await tx
            .select({ id: digitalIdsTable.id })
            .from(digitalIdsTable)
            .where(eq(digitalIdsTable.studentRecordId, params.data.studentId))
            .orderBy(desc(digitalIdsTable.issuedAt))
            .limit(1);
          if (latestId) {
            await tx
              .update(digitalIdsTable)
              .set({ expiresAt: dateToISODate(body.data.validityEnd) })
              .where(eq(digitalIdsTable.id, latestId.id));
          }
        }
      });
      res.json(UpdateStudentResponse.parse(await studentRecord(params.data.studentId)));
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "That student ID is already in use." });
        return;
      }
      sendHttpError(res, error);
    }
  },
);

router.patch(
  "/admin/ids/:id/status",
  ...adminOnly,
  async (req, res): Promise<void> => {
    const params = UpdateDigitalIdStatusParams.safeParse(req.params);
    const body = UpdateDigitalIdStatusBody.safeParse(req.body);
    if (!params.success || !body.success) {
      const message = !params.success
        ? params.error.message
        : !body.success
          ? body.error.message
          : "Invalid request.";
      res.status(400).json({ error: message });
      return;
    }
    try {
      const [id] = await db
        .select()
        .from(digitalIdsTable)
        .where(eq(digitalIdsTable.id, params.data.id))
        .limit(1);
      if (!id) {
        res.status(404).json({ error: "Digital ID not found." });
        return;
      }
      const [latest] = await db
        .select({ id: digitalIdsTable.id })
        .from(digitalIdsTable)
        .where(eq(digitalIdsTable.studentRecordId, id.studentRecordId))
        .orderBy(desc(digitalIdsTable.issuedAt))
        .limit(1);
      const isCurrentId = latest?.id === id.id;
      if (body.data.status === "active") {
        if (!isCurrentId || id.status === "revoked") {
          res.status(409).json({ error: "Reissue a revoked or superseded ID instead of reactivating it." });
          return;
        }
        if (id.expiresAt < new Date().toISOString().slice(0, 10)) {
          res.status(409).json({ error: "Update the student's validity date before activating this ID." });
          return;
        }
      }
      await db.transaction(async (tx) => {
        await tx
          .update(digitalIdsTable)
          .set({
            status: body.data.status,
            revokedAt: body.data.status === "revoked" ? new Date() : null,
          })
          .where(eq(digitalIdsTable.id, id.id));
        if (isCurrentId) {
          await tx
            .update(studentsTable)
            .set({
              status: body.data.status === "active" ? "active" : body.data.status,
            })
            .where(eq(studentsTable.id, id.studentRecordId));
        }
      });
      const [updated] = await db
        .select()
        .from(digitalIdsTable)
        .where(eq(digitalIdsTable.id, id.id))
        .limit(1);
      res.json(
        UpdateDigitalIdStatusResponse.parse(await digitalIdView(req, updated)),
      );
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.post(
  "/admin/ids/:id/reissue",
  ...adminOnly,
  async (req, res): Promise<void> => {
    const params = ReissueDigitalIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      const [oldId] = await db
        .select()
        .from(digitalIdsTable)
        .where(eq(digitalIdsTable.id, params.data.id))
        .limit(1);
      if (!oldId) {
        res.status(404).json({ error: "Digital ID not found." });
        return;
      }
      if (oldId.expiresAt < new Date().toISOString().slice(0, 10)) {
        res.status(409).json({ error: "Update the student's validity date before reissuing an expired ID." });
        return;
      }
      const token = createQrToken();
      const created = await db.transaction(async (tx) => {
        await tx
          .update(digitalIdsTable)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(digitalIdsTable.studentRecordId, oldId.studentRecordId),
              eq(digitalIdsTable.status, "active"),
            ),
          );
        await tx
          .update(studentsTable)
          .set({ status: "active" })
          .where(eq(studentsTable.id, oldId.studentRecordId));
        const [next] = await tx
          .insert(digitalIdsTable)
          .values({
            studentRecordId: oldId.studentRecordId,
            status: "active",
            tokenHash: hashToken(token),
            encryptedToken: encryptToken(token),
            expiresAt: oldId.expiresAt,
          })
          .returning();
        return next;
      });
      const view = await digitalIdView(req, created);
      // The new raw token is already encrypted at rest; use the freshly issued one for this response.
      view.qrUrl = qrUrlForRequest(req, token);
      res.json(ReissueDigitalIdResponse.parse(view));
    } catch (error) {
      sendHttpError(res, error);
    }
  },
);

router.get("/admin/departments", ...adminOnly, async (_req, res): Promise<void> => {
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
      .orderBy(departmentsTable.name);
    res.json(ListAdminDepartmentsResponse.parse(departments));
  } catch (error) {
    sendHttpError(res, error);
  }
});

router.post("/admin/departments", ...adminOnly, async (req, res): Promise<void> => {
  const parsed = CreateDepartmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [department] = await db
      .insert(departmentsTable)
      .values({ name: parsed.data.name.trim(), code: parsed.data.code.trim().toUpperCase() })
      .returning({
        id: departmentsTable.id,
        name: departmentsTable.name,
        code: departmentsTable.code,
        isActive: departmentsTable.isActive,
      });
    res.status(201).json(CreateDepartmentResponse.parse(department));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "A department with that name or code already exists." });
      return;
    }
    sendHttpError(res, error);
  }
});

router.patch(
  "/admin/departments/:id",
  ...adminOnly,
  async (req, res): Promise<void> => {
    const params = UpdateDepartmentParams.safeParse(req.params);
    const body = UpdateDepartmentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      const message = !params.success
        ? params.error.message
        : !body.success
          ? body.error.message
          : "Invalid request.";
      res.status(400).json({ error: message });
      return;
    }
    try {
      const [department] = await db
        .update(departmentsTable)
        .set({
          ...(body.data.name !== undefined ? { name: body.data.name.trim() } : {}),
          ...(body.data.code !== undefined ? { code: body.data.code.trim().toUpperCase() } : {}),
          ...(body.data.isActive !== undefined ? { isActive: body.data.isActive } : {}),
        })
        .where(eq(departmentsTable.id, params.data.id))
        .returning({
          id: departmentsTable.id,
          name: departmentsTable.name,
          code: departmentsTable.code,
          isActive: departmentsTable.isActive,
        });
      if (!department) {
        res.status(404).json({ error: "Department not found." });
        return;
      }
      res.json(UpdateDepartmentResponse.parse(department));
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "A department with that name or code already exists." });
        return;
      }
      sendHttpError(res, error);
    }
  },
);

router.get("/admin/requests", ...adminOnly, async (_req, res): Promise<void> => {
  try {
    const [lostReports, corrections] = await Promise.all([
      db
        .select({
          id: lostIdReportsTable.id,
          reason: lostIdReportsTable.reason,
          status: lostIdReportsTable.status,
          createdAt: lostIdReportsTable.createdAt,
          studentName: studentsTable.fullName,
          studentId: studentsTable.studentId,
        })
        .from(lostIdReportsTable)
        .innerJoin(studentsTable, eq(lostIdReportsTable.studentRecordId, studentsTable.id))
        .orderBy(desc(lostIdReportsTable.createdAt))
        .limit(100),
      db
        .select({
          id: correctionRequestsTable.id,
          field: correctionRequestsTable.field,
          requestedValue: correctionRequestsTable.requestedValue,
          reason: correctionRequestsTable.reason,
          status: correctionRequestsTable.status,
          createdAt: correctionRequestsTable.createdAt,
          studentName: studentsTable.fullName,
          studentId: studentsTable.studentId,
        })
        .from(correctionRequestsTable)
        .innerJoin(studentsTable, eq(correctionRequestsTable.studentRecordId, studentsTable.id))
        .orderBy(desc(correctionRequestsTable.createdAt))
        .limit(100),
    ]);
      res.json(
        ListAdminRequestsResponse.parse({
          lostReports,
          corrections,
        } satisfies AdminRequests),
      );
  } catch (error) {
    sendHttpError(res, error);
  }
});

export default router;
