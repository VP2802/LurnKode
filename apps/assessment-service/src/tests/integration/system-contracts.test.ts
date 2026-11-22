/**
 * Cross-module contracts over M3's HTTP surface:
 * - M1: access tokens (RS256, M1 claims and role names) authenticate callers.
 * - M2: enrollment and course ownership are answered by M2's real endpoints
 *       (GET /api/v1/my/enrollments, GET /api/v1/courses/:id), faked here.
 * - M6: submissions use M6's submission contract; results arrive on /internal/v1/judge-results.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import { app } from "../../app";
import { JudgeServiceClient } from "../../clients/judge.client";
import { courseClient } from "../../clients/course.client";
import { env } from "../../config/env";
import { setAccessTokenKey } from "../../middlewares/auth.middleware";
import { ServiceError } from "../../middlewares/error.middleware";
import { assessmentRepository } from "../../repositories/assessment.repository";
import { AttemptService } from "../../services/attempt.service";
import { QueueService } from "../../services/queue.service";

let m1Key: KeyLike;
const realFetch = globalThis.fetch;

/** What the fake M2 knows: learner → enrolled course ids, course → instructor id. */
const m2 = {
  enrollments: new Map<string, string[]>(),
  courses: new Map<string, string>(),
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeM2(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const token = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1];
  const sub = token ? (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string) : null;

  if (url.pathname === "/api/v1/my/enrollments" && sub) {
    const courseIds = m2.enrollments.get(sub) ?? [];
    return Promise.resolve(
      json(200, { success: true, data: courseIds.map((courseId) => ({ courseId, learnerId: sub, status: "in_progress" })) })
    );
  }
  const course = /^\/api\/v1\/courses\/([^/]+)$/.exec(url.pathname);
  if (course && sub) {
    const instructorId = m2.courses.get(course[1]!);
    return Promise.resolve(
      instructorId
        ? json(200, { success: true, data: { id: course[1], instructorId } })
        : json(404, { success: false, error: { code: "NOT_FOUND", message: "Course not found" } })
    );
  }
  return Promise.resolve(json(404, { success: false, error: { code: "NOT_FOUND", message: "NOT_FOUND" } }));
}

async function m1Token(sub: string, role: "Learner" | "Instructor" | "Admin"): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "RS256", kid: "m1-auth-key-v1", typ: "JWT" })
    .setSubject(sub)
    .setIssuer("https://lurnkode.local/m1")
    .setAudience("lurnkode-api")
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti(crypto.randomUUID())
    .sign(m1Key);
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const mcqItem = {
  type: "mcq",
  title: "Complexity",
  prompt: "Binary search runs in?",
  points: 5,
  sortOrder: 1,
  mcqPayload: {
    mcqType: "single",
    options: [
      { id: "o1", text: "O(log n)" },
      { id: "o2", text: "O(n)" },
    ],
    correctOptionIds: ["o1"],
  },
};
const programmingItem = {
  type: "programming",
  title: "Palindrome",
  prompt: "Print True if the input line is a palindrome",
  points: 20,
  sortOrder: 2,
  programmingPayload: {
    language: "python",
    limits: { cpu: 1, memoryMb: 128, timeoutMs: 2000 },
    hiddenTestCases: [
      { id: "tc_1", input: "racecar", expectedOutput: "True", hidden: false, weight: 1 },
      { id: "tc_2", input: "hello", expectedOutput: "False", hidden: true, weight: 1 },
    ],
  },
};

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  m1Key = keys.privateKey;
  setAccessTokenKey(keys.publicKey);
  globalThis.fetch = fakeM2 as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setAccessTokenKey(null);
});

describe("M1 tokens + M2 checks", () => {
  const instructorId = crypto.randomUUID();
  const otherInstructorId = crypto.randomUUID();
  const learnerId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const courseId = crypto.randomUUID();
  let assessmentId = "";

  beforeAll(() => {
    m2.courses.set(courseId, instructorId);
    m2.enrollments.set(learnerId, [courseId]);
  });

  it("lets the owning instructor author with an M1 token and M1's role name", async () => {
    const created = await call("POST", "/instructor/assessments", {
      headers: bearer(await m1Token(instructorId, "Instructor")),
      body: { courseId, title: "Quiz with tokens" },
    });
    expect(created.status).toBe(201);
    assessmentId = created.body.id;

    const item = await call("POST", `/instructor/assessments/${assessmentId}/items`, {
      headers: bearer(await m1Token(instructorId, "Instructor")),
      body: mcqItem,
    });
    expect(item.status).toBe(201);

    const published = await call("POST", `/instructor/assessments/${assessmentId}/publish`, {
      headers: bearer(await m1Token(instructorId, "Instructor")),
    });
    expect(published.status).toBe(200);
  });

  it("refuses other instructors and unknown courses, but lets admins in", async () => {
    const otherToken = await m1Token(otherInstructorId, "Instructor");
    const notOwner = await call("POST", "/instructor/assessments", {
      headers: bearer(otherToken),
      body: { courseId, title: "Not my course" },
    });
    expect(notOwner.status).toBe(403);

    const editOthers = await call("GET", `/instructor/assessments/${assessmentId}`, { headers: bearer(otherToken) });
    expect(editOthers.status).toBe(403);

    const unknownCourse = await call("POST", "/instructor/assessments", {
      headers: bearer(await m1Token(instructorId, "Instructor")),
      body: { courseId: crypto.randomUUID(), title: "Ghost course" },
    });
    expect(unknownCourse.status).toBe(404);

    const admin = await call("GET", `/instructor/assessments/${assessmentId}`, {
      headers: bearer(await m1Token(crypto.randomUUID(), "Admin")),
    });
    expect(admin.status).toBe(200);
  });

  it("lets enrolled learners start an attempt and refuses the rest", async () => {
    const enrolled = await call("POST", `/learner/assessments/${assessmentId}/attempts`, {
      headers: bearer(await m1Token(learnerId, "Learner")),
    });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.attempt.userId).toBe(learnerId);

    const stranger = await call("POST", `/learner/assessments/${assessmentId}/attempts`, {
      headers: bearer(await m1Token(strangerId, "Learner")),
    });
    expect(stranger.status).toBe(403);
  });

  it("rejects tokens M1 did not sign", async () => {
    const forged = await new SignJWT({ role: "Admin" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("forger")
      .setIssuer("https://lurnkode.local/m1")
      .setAudience("lurnkode-api")
      .setExpirationTime("15m")
      .sign((await generateKeyPair("RS256")).privateKey);
    const res = await call("GET", `/instructor/assessments/${assessmentId}`, { headers: bearer(forged) });
    expect(res.status).toBe(401);
  });
});

describe("M6 result callback", () => {
  const instructorHeaders = { "x-user-id": "instructor_m6", "x-user-role": "Instructor" };
  const learnerHeaders = { "x-user-id": `learner_m6_${Date.now()}`, "x-user-role": "Learner" };
  const callbackHeaders = { authorization: `Bearer ${env.JUDGE_CALLBACK_TOKEN}` };

  async function submittedCode(): Promise<{ attemptId: string; submissionId: string; judgeJobId: string }> {
    const created = await call("POST", "/instructor/assessments", {
      headers: instructorHeaders,
      body: { courseId: `course_m6_${Date.now()}`, title: "Judge contract" },
    });
    const assessmentId = created.body.id;
    const item = await call("POST", `/instructor/assessments/${assessmentId}/items`, {
      headers: instructorHeaders,
      body: programmingItem,
    });
    await call("POST", `/instructor/assessments/${assessmentId}/publish`, { headers: instructorHeaders });

    const started = await call("POST", `/learner/assessments/${assessmentId}/attempts`, { headers: learnerHeaders });
    expect(started.status).toBe(201);
    const attemptId = started.body.attempt.id;

    const submitted = await call("POST", `/learner/attempts/${attemptId}/code-submissions`, {
      headers: learnerHeaders,
      body: { itemId: item.body.id, language: "python", sourceCode: "print(input() == input()[::-1])" },
    });
    expect(submitted.status).toBe(202);
    expect(typeof submitted.body.judgeJobId).toBe("string");
    return { attemptId, submissionId: submitted.body.id, judgeJobId: submitted.body.judgeJobId };
  }

  function m6Result(submissionId: string, judgeSubmissionId: string) {
    return {
      contractVersion: "1.0",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      judgeSubmissionId,
      clientSubmissionId: submissionId,
      attemptId: crypto.randomUUID(),
      assessmentItemId: crypto.randomUUID(),
      revision: 1,
      executionStatus: "completed",
      verdict: "WA",
      summary: { totalTests: 2, passedTests: 1, failedTests: 1 },
      metrics: { runtimeMs: 42 },
      diagnostics: {
        compileMessage: null,
        tests: [
          { testCaseId: "tc_1", visibility: "public", verdict: "AC", passed: true, runtimeMs: 20, input: "racecar" },
          { testCaseId: "tc_2", visibility: "hidden", verdict: "WA", passed: false, runtimeMs: 22 },
        ],
      },
      traceId: "trace",
    };
  }

  it("grades a submission from M6's callback, idempotently", async () => {
    const { attemptId, submissionId, judgeJobId } = await submittedCode();
    const result = m6Result(submissionId, judgeJobId);

    const accepted = await call("POST", "/internal/v1/judge-results", { headers: callbackHeaders, body: result });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "success", submissionId, idempotent: false });

    const replay = await call("POST", "/internal/v1/judge-results", { headers: callbackHeaders, body: result });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);

    const submission = await assessmentRepository.findCodeSubmissionById(submissionId);
    expect(submission).toMatchObject({ status: "judged", finalStatus: "WA", score: 10, executionMs: 42 });

    const finished = await call("POST", `/learner/attempts/${attemptId}/finish`, { headers: learnerHeaders });
    expect(finished.body).toMatchObject({ status: "completed", score: 10, maxScore: 20 });
  });

  it("refuses bad tokens, malformed results and results for another judge run", async () => {
    const { submissionId, judgeJobId } = await submittedCode();

    const wrongToken = await call("POST", "/internal/v1/judge-results", {
      headers: { authorization: "Bearer nope" },
      body: m6Result(submissionId, judgeJobId),
    });
    expect(wrongToken.status).toBe(401);

    const legacyHeader = await call("POST", "/internal/v1/judge-results", {
      headers: { "x-internal-token": env.INTERNAL_SERVICE_TOKEN },
      body: m6Result(submissionId, judgeJobId),
    });
    expect(legacyHeader.status).toBe(401);

    const malformed = await call("POST", "/internal/v1/judge-results", {
      headers: callbackHeaders,
      body: { submissionId, status: "completed" },
    });
    expect(malformed.status).toBe(422);

    const otherRun = await call("POST", "/internal/v1/judge-results", {
      headers: callbackHeaders,
      body: m6Result(submissionId, crypto.randomUUID()),
    });
    expect(otherRun.status).toBe(409);

    const unknown = await call("POST", "/internal/v1/judge-results", {
      headers: callbackHeaders,
      body: m6Result(crypto.randomUUID(), crypto.randomUUID()),
    });
    expect(unknown.status).toBe(404);
  });
});

describe("dispatch to a configured M6", () => {
  async function startedAttempt(): Promise<{ attemptId: string; userId: string; itemId: string }> {
    const headers = { "x-user-id": "instructor_dispatch", "x-user-role": "instructor" };
    const created = await call("POST", "/instructor/assessments", {
      headers,
      body: { courseId: `course_dispatch_${Date.now()}`, title: "Dispatch" },
    });
    const item = await call("POST", `/instructor/assessments/${created.body.id}/items`, { headers, body: programmingItem });
    await call("POST", `/instructor/assessments/${created.body.id}/publish`, { headers });
    const userId = `learner_dispatch_${crypto.randomUUID()}`;
    const started = await call("POST", `/learner/assessments/${created.body.id}/attempts`, {
      headers: { "x-user-id": userId, "x-user-role": "learner" },
    });
    return { attemptId: started.body.attempt.id, userId, itemId: item.body.id };
  }

  it("sends the submission to M6 and stores M6's judge submission id", async () => {
    const sent: any[] = [];
    const judge = new JudgeServiceClient("http://judge.test", "m3-token", 1000, (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ judgeSubmissionId: "1d2c3b4a-0000-4000-8000-00000000abcd", status: "queued" }), {
        status: 202,
      });
    }) as unknown as typeof fetch);
    const attempts = new AttemptService(assessmentRepository, courseClient, new QueueService(judge));

    const { attemptId, userId, itemId } = await startedAttempt();
    const first = await attempts.submitCode(attemptId, userId, itemId, "python", "print(True)");
    const second = await attempts.submitCode(attemptId, userId, itemId, "python", "print(False)");

    expect(first.judgeJobId).toBe("1d2c3b4a-0000-4000-8000-00000000abcd");
    expect(sent.map((request) => request.revision)).toEqual([1, 2]);
    expect(sent[0]).toMatchObject({
      contractVersion: "1.0",
      clientSubmissionId: first.id,
      attemptId,
      assessmentItemId: itemId,
      language: "python",
    });
    expect(second.id).not.toBe(first.id);
  });

  it("marks a submission M6 rejected as failed so the attempt can still finish", async () => {
    const judge = new JudgeServiceClient("http://judge.test", "m3-token", 1000, (async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_JUDGE_PACKAGE", message: "bad", retryable: false } }), {
        status: 422,
      })) as unknown as typeof fetch);
    const attempts = new AttemptService(assessmentRepository, courseClient, new QueueService(judge));

    const { attemptId, userId, itemId } = await startedAttempt();
    const error = await attempts.submitCode(attemptId, userId, itemId, "python", "print(True)").catch((e) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.statusCode).toBe(502);

    const [submission] = await assessmentRepository.listCodeSubmissionsByAttemptId(attemptId);
    expect(submission?.status).toBe("failed");

    const finished = await attempts.finishAttempt(attemptId, userId);
    expect(finished.status).toBe("completed");
  });
});
