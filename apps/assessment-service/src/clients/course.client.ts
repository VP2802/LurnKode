/**
 * @file clients/course.client.ts
 * @description Resilient HTTP client for inter-service RPC to M2 (Course Service).
 *
 * Microservice Role:
 * - Checks whether a learner is actively enrolled in a course prior to starting an assessment attempt.
 * - Checks whether an instructor may manage (author assessments for) a course.
 * - Enforces timeout and defensive error handling to prevent cascading failures.
 *
 * M2 endpoints used:
 * - With the caller's M1 access token (preferred; M2 verifies the token itself):
 *     GET /api/v1/my/enrollments   — learner's enrollments
 *     GET /api/v1/courses/:id      — course detail incl. instructorId
 * - Without a token (gateway-header mode):
 *     GET /internal/courses/:courseId/enrollments/:userId  (X-Internal-Service-Key)
 *   This internal endpoint is part of the M3 ↔ M2 contract but is not implemented by M2 yet.
 */

import { env } from "../config/env";

export interface EnrollmentCheckResult {
  enrolled: boolean;
  role?: string;
  status?: string;
}

export interface CourseAccessResult {
  /** False when M2 does not know the course (or the caller may not see it). */
  exists: boolean;
  /** True when the caller owns the course or is an admin. */
  canManage: boolean;
}

export interface M2CallerContext {
  correlationId?: string;
  /** The caller's M1 access token, forwarded as `Authorization: Bearer`. */
  accessToken?: string;
}

interface M2Envelope<T> {
  success?: boolean;
  data?: T;
}

interface M2Enrollment {
  courseId?: string;
  learnerId?: string;
  status?: string;
}

interface M2CourseDetail {
  id?: string;
  instructorId?: string;
}

export class CourseServiceClient {
  private baseUrl: string;
  private timeoutMs: number;
  private internalKey: string;

  constructor() {
    this.baseUrl = env.M2_COURSE_SERVICE_URL.replace(/\/+$/, "");
    this.timeoutMs = env.M2_REQUEST_TIMEOUT_MS;
    this.internalKey = env.M2_INTERNAL_SERVICE_KEY;
  }

  private async get(path: string, headers: Record<string, string>, correlationId?: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
        ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private describeError(err: unknown): string {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return isTimeout ? "Timeout exceeded" : String(err);
  }

  /**
   * Verifies if a user is actively enrolled in a specific course.
   *
   * @param courseId - UUID string of the course
   * @param userId - UUID string of the learner
   * @param caller - Correlation id and, when available, the learner's M1 access token
   */
  async checkEnrollment(
    courseId: string,
    userId: string,
    caller: M2CallerContext = {}
  ): Promise<EnrollmentCheckResult> {
    try {
      return caller.accessToken
        ? await this.checkEnrollmentAsLearner(courseId, userId, caller)
        : await this.checkEnrollmentInternal(courseId, userId, caller);
    } catch (err: unknown) {
      console.warn(
        `[M2 Client] Failed to check enrollment for course ${courseId}, user ${userId}. Error: ${this.describeError(err)}`
      );

      // In development/test mode, fall back gracefully if external M2 is not running
      if (env.NODE_ENV !== "production") {
        console.warn("[M2 Client] Development mode: permitting enrollment fallback for local testing.");
        return { enrolled: true, role: "student", status: "active" };
      }

      throw new Error(`Inter-service error checking enrollment with M2: ${this.describeError(err)}`);
    }
  }

  /** GET /api/v1/my/enrollments with the learner's own token. */
  private async checkEnrollmentAsLearner(
    courseId: string,
    userId: string,
    caller: M2CallerContext
  ): Promise<EnrollmentCheckResult> {
    const response = await this.get(
      "/api/v1/my/enrollments",
      { Authorization: `Bearer ${caller.accessToken}` },
      caller.correlationId
    );

    // M2 refused the token or the role: treat as not enrolled rather than an outage.
    if (response.status === 401 || response.status === 403) {
      return { enrolled: false };
    }
    if (!response.ok) {
      throw new Error(`M2 Course Service returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as M2Envelope<M2Enrollment[]>;
    const enrollments = Array.isArray(json?.data) ? json.data : [];
    const match = enrollments.find(
      (enrollment) => enrollment.courseId === courseId && (!enrollment.learnerId || enrollment.learnerId === userId)
    );
    return match ? { enrolled: true, role: "learner", status: match.status } : { enrolled: false };
  }

  /** GET /internal/courses/:courseId/enrollments/:userId with the internal service key. */
  private async checkEnrollmentInternal(
    courseId: string,
    userId: string,
    caller: M2CallerContext
  ): Promise<EnrollmentCheckResult> {
    const response = await this.get(
      `/internal/courses/${encodeURIComponent(courseId)}/enrollments/${encodeURIComponent(userId)}`,
      { "X-Internal-Service-Key": this.internalKey },
      caller.correlationId
    );

    if (response.status === 404) {
      if (env.NODE_ENV !== "production") {
        console.warn(
          "[M2 Client] Endpoint returned 404 in development mode. Permitting fallback for course " + courseId + ", user " + userId + "."
        );
        return { enrolled: true, role: "student", status: "active" };
      }
      return { enrolled: false };
    }

    if (!response.ok) {
      throw new Error(`M2 Course Service returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as
      | (M2Envelope<{ enrolled?: boolean; role?: string; status?: string }> & {
          enrolled?: boolean;
          role?: string;
          status?: string;
        })
      | undefined;
    const data = json?.data ?? json ?? {};
    return {
      enrolled: Boolean(data.enrolled),
      role: data.role,
      status: data.status,
    };
  }

  /**
   * Checks whether the caller may author assessments for a course, using M2's
   * course detail endpoint with the caller's own token. Admins may manage any course.
   */
  async checkCourseAccess(
    courseId: string,
    userId: string,
    role: string,
    caller: M2CallerContext & { accessToken: string }
  ): Promise<CourseAccessResult> {
    try {
      const response = await this.get(
        `/api/v1/courses/${encodeURIComponent(courseId)}`,
        { Authorization: `Bearer ${caller.accessToken}` },
        caller.correlationId
      );

      // 400: not a UUID; 404: unknown course (or an unpublished course the caller cannot see).
      if (response.status === 400 || response.status === 404) {
        return { exists: false, canManage: false };
      }
      if (response.status === 401 || response.status === 403) {
        return { exists: true, canManage: false };
      }
      if (!response.ok) {
        throw new Error(`M2 Course Service returned HTTP ${response.status}`);
      }

      const json = (await response.json()) as M2Envelope<M2CourseDetail>;
      const course = json?.data ?? {};
      return { exists: true, canManage: role === "admin" || course.instructorId === userId };
    } catch (err: unknown) {
      console.warn(`[M2 Client] Failed to check course ${courseId} for user ${userId}. Error: ${this.describeError(err)}`);

      if (env.NODE_ENV !== "production") {
        console.warn("[M2 Client] Development mode: permitting course access fallback for local testing.");
        return { exists: true, canManage: true };
      }

      throw new Error(`Inter-service error checking course access with M2: ${this.describeError(err)}`);
    }
  }
}

export const courseClient = new CourseServiceClient();
