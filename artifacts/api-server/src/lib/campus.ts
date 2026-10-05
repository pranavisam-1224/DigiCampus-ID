import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  departmentsTable,
  digitalIdsTable,
  studentsTable,
  usersTable,
  type User,
} from "@workspace/db";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function qrEncryptionKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be configured to encrypt QR tokens.");
  }
  return createHash("sha256")
    .update("digicampus-id:qr-token:v1:")
    .update(sessionSecret)
    .digest();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", qrEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(encryptedToken: string): string {
  const [iv, tag, ciphertext] = encryptedToken.split(".");
  if (!iv || !tag || !ciphertext) throw new Error("Stored QR token is malformed.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    qrEncryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function createQrToken(): string {
  return randomBytes(32).toString("base64url");
}

export function dateToISODate(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new HttpError(400, "Choose a valid date.");
  return value.toISOString().slice(0, 10);
}

export function qrUrlForRequest(req: Request, token: string): string {
  const configuredDomains = process.env.REPLIT_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]?.split(",")[0]?.trim()
    : forwardedHost?.split(",")[0]?.trim();
  const rawHost = configuredDomains?.[0] || host || req.get("host");
  if (!rawHost || !/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost)) {
    throw new Error("Could not determine a safe host for the QR verification URL.");
  }
  const protocol =
    process.env.REPLIT_DOMAINS?.trim() || req.headers["x-forwarded-proto"]
      ? "https"
      : req.protocol;
  return `${protocol}://${rawHost}/verify?token=${encodeURIComponent(token)}`;
}

function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.DIGICAMPUS_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

export async function resolveActor(req: Request): Promise<User> {
  const auth = getAuth(req);
  if (!auth.userId) throw new HttpError(401, "Sign in to continue.");

  let identity;
  try {
    identity = await clerkClient.users.getUser(auth.userId);
  } catch {
    throw new HttpError(401, "Your sign-in session could not be verified.");
  }
  const email = identity.primaryEmailAddress?.emailAddress?.trim().toLocaleLowerCase();
  if (!email) throw new HttpError(403, "A verified email address is required.");
  if (identity.primaryEmailAddress?.verification?.status !== "verified") {
    throw new HttpError(403, "Verify your email address before continuing.");
  }
  const fullName =
    [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
    email;
  const isAdmin = configuredAdminEmails().has(email);

  let [actor] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, auth.userId))
    .limit(1);

  if (!actor) {
    const [emailMatch] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (emailMatch?.clerkUserId && emailMatch.clerkUserId !== auth.userId) {
      throw new HttpError(409, "This email is linked to another campus account.");
    }
    if (emailMatch) {
      const [linked] = await db
        .update(usersTable)
        .set({
          clerkUserId: auth.userId,
          fullName,
          ...(isAdmin ? { role: "admin" as const, status: "active" as const } : {}),
        })
        .where(eq(usersTable.id, emailMatch.id))
        .returning();
      actor = linked;
    } else {
      const [created] = await db
        .insert(usersTable)
        .values({
          clerkUserId: auth.userId,
          email,
          fullName,
          role: isAdmin ? "admin" : "student",
          status: isAdmin ? "active" : "unregistered",
        })
        .onConflictDoNothing()
        .returning();
      actor =
        created ??
        (
          await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.clerkUserId, auth.userId))
            .limit(1)
        )[0];
    }
  } else {
    const [updated] = await db
      .update(usersTable)
      .set({
        email,
        fullName,
        ...(isAdmin ? { role: "admin" as const, status: "active" as const } : {}),
      })
      .where(eq(usersTable.id, actor.id))
      .returning();
    actor = updated;
  }

  if (!actor) throw new HttpError(409, "Could not link your campus account.");
  return actor;
}

export const requireSignedIn: RequestHandler = async (req, res, next) => {
  try {
    res.locals.actor = await resolveActor(req);
    next();
  } catch (error) {
    sendHttpError(res, error);
  }
};

export function requireRole(...roles: User["role"][]): RequestHandler {
  return (_req, res, next) => {
    const actor = res.locals.actor as User | undefined;
    if (!actor) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    if (!roles.includes(actor.role)) {
      res.status(403).json({ error: "Your account does not have access to this page." });
      return;
    }
    if (actor.status !== "active") {
      res.status(403).json({ error: "Your campus account is awaiting approval or is inactive." });
      return;
    }
    next();
  };
}

export function currentAccount(actor: User) {
  return {
    id: actor.id,
    email: actor.email,
    fullName: actor.fullName,
    role: actor.status === "unregistered" ? "unregistered" : actor.role,
    status: actor.status,
    needsRegistration: actor.status === "unregistered",
  };
}

export function sendHttpError(res: Response, error: unknown): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "An unexpected server error occurred." });
}

export async function getStudentForActor(actor: User) {
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.userId, actor.id))
    .limit(1);
  return student;
}

export async function issueDigitalId(
  studentRecordId: string,
  expiresAt: string,
  tx: any = db,
) {
  const token = createQrToken();
  const [record] = await tx
    .insert(digitalIdsTable)
    .values({
      studentRecordId,
      status: "active",
      tokenHash: hashToken(token),
      encryptedToken: encryptToken(token),
      expiresAt,
    })
    .returning();
  return { record, token };
}

export function computedIdStatus(
  digitalIdStatus: "active" | "suspended" | "revoked",
  expiresAt: string,
): "active" | "suspended" | "revoked" | "expired" {
  if (digitalIdStatus !== "active") return digitalIdStatus;
  return expiresAt < new Date().toISOString().slice(0, 10) ? "expired" : "active";
}

export async function seedDepartments(): Promise<void> {
  const defaults = [
    { name: "Computer Science", code: "CS" },
    { name: "Engineering", code: "ENG" },
    { name: "Business & Management", code: "BUS" },
    { name: "Arts & Humanities", code: "AH" },
  ];
  for (const department of defaults) {
    await db.insert(departmentsTable).values(department).onConflictDoNothing();
  }
}

export async function activeDigitalId(studentRecordId: string) {
  const [id] = await db
    .select()
    .from(digitalIdsTable)
    .where(
      and(
        eq(digitalIdsTable.studentRecordId, studentRecordId),
        eq(digitalIdsTable.status, "active"),
      ),
    )
    .orderBy(desc(digitalIdsTable.issuedAt))
    .limit(1);
  return id;
}
