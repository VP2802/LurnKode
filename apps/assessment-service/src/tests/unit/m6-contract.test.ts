import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JudgeClientError, JudgeServiceClient } from "../../clients/judge.client";
import { toJudgeSubmissionRequest, type JudgeJobPayload } from "../../services/queue.service";
import { fromM6JudgeResult, m6JudgeResultSchema } from "../../schemas/assessment.zod";
import type { AssessmentItem } from "../../schemas/assessment.types";

const item: AssessmentItem = {
  id: crypto.randomUUID(),
  assessmentId: crypto.randomUUID(),
  type: "programming",
  title: "Palindrome",
  prompt: "Print True if the input line is a palindrome",
  points: 20,
  sortOrder: 1,
  programmingPayload: {
    language: "python",
    limits: { cpu: 1, memoryMb: 128, timeoutMs: 2000 },
    hiddenTestCases: [
      { id: "tc_1", input: "racecar\n", expectedOutput: "True\n", hidden: false, weight: 1 },
      { id: "tc_2", input: "hello\n", expectedOutput: "False\n", hidden: true, weight: 3 },
    ],
  },
  createdAt: new Date("2026-11-22T09:00:00Z"),
  updatedAt: new Date("2026-11-22T10:00:00Z"),
};

const payload: JudgeJobPayload = {
  submissionId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  item,
  revision: 2,
  language: "python",
  sourceCode: "s = input()\nprint(s == s[::-1])\n",
  correlationId: "trace-abcdef12",
};

// M6's own modules, when this checkout has them (they are not inside the M3 container image).
const m6Src = new URL("../../../../../m6-judge/src/", import.meta.url);
const hasM6 = existsSync(fileURLToPath(new URL("domain/validate.ts", m6Src)));
const withM6 = hasM6 ? it : it.skip;

/** Builds the callback body exactly as M6's store does (m6-judge/src/db/store.ts completeSubmission). */
function m6Callback(outcome: Record<string, unknown>, judgeSubmissionId = crypto.randomUUID()) {
  const { events: _events, ...result } = outcome;
  return {
    contractVersion: "1.0",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    judgeSubmissionId,
    clientSubmissionId: payload.submissionId,
    attemptId: payload.attemptId,
    assessmentItemId: item.id,
    revision: payload.revision,
    ...result,
    traceId: "trace",
  };
}

describe("M3 → M6 submission", () => {
  it("maps an M3 code submission onto M6's request contract", () => {
    const request = toJudgeSubmissionRequest(payload);

    expect(request).toMatchObject({
      contractVersion: "1.0",
      clientSubmissionId: payload.submissionId,
      attemptId: payload.attemptId,
      assessmentItemId: item.id,
      revision: 2,
      language: "python",
      requestedRuntimeLimits: { cpuCores: 1, memoryLimitMb: 128, timeLimitMs: 2000 },
    });
    expect(request.judgePackage.packageId).toBe(item.id);
    expect(Number.isInteger(request.judgePackage.version)).toBe(true);
    expect(request.judgePackage.testCases).toEqual([
      { testCaseId: "tc_1", stdin: "racecar\n", expectedOutput: "True\n", visibility: "public" },
      { testCaseId: "tc_2", stdin: "hello\n", expectedOutput: "False\n", visibility: "hidden" },
    ]);
  });

  withM6("passes M6's own request validator", async () => {
    const { validateSubmission } = await import(new URL("domain/validate.ts", m6Src).href);
    const result = validateSubmission(toJudgeSubmissionRequest(payload));
    expect(result).toMatchObject({ ok: true });
  });

  it("posts to M6 with its service token and an idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ contractVersion: "1.0", judgeSubmissionId: "9b1f6f1e-0000-4000-8000-000000000001", status: "queued" }),
        { status: 202 }
      );
    }) as unknown as typeof fetch;

    const client = new JudgeServiceClient("http://judge-api:4000/", "m3-token", 1000, fakeFetch);
    const accepted = await client.submit(toJudgeSubmissionRequest(payload), {
      idempotencyKey: payload.submissionId,
      traceId: payload.correlationId,
    });

    expect(accepted).toEqual({ judgeSubmissionId: "9b1f6f1e-0000-4000-8000-000000000001", status: "queued" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://judge-api:4000/internal/v1/judge-submissions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer m3-token");
    expect(headers["idempotency-key"]).toBe(payload.submissionId);
    expect(headers["x-trace-id"]).toBe("trace-abcdef12");
    expect(JSON.parse(String(calls[0]!.init.body)).contractVersion).toBe("1.0");
  });

  it("reports M6 rejections and outages distinctly", async () => {
    const rejecting = new JudgeServiceClient("http://judge", "t", 1000, (async () =>
      new Response(
        JSON.stringify({ error: { code: "UNSUPPORTED_LANGUAGE", message: "no", retryable: false } }),
        { status: 422 }
      )) as unknown as typeof fetch);
    const unreachable = new JudgeServiceClient("http://judge", "t", 1000, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    const rejection = await rejecting.submit(toJudgeSubmissionRequest(payload), { idempotencyKey: "k" }).catch((e) => e);
    expect(rejection).toBeInstanceOf(JudgeClientError);
    expect(rejection).toMatchObject({ status: 422, code: "UNSUPPORTED_LANGUAGE", retryable: false });

    const outage = await unreachable.submit(toJudgeSubmissionRequest(payload), { idempotencyKey: "k" }).catch((e) => e);
    expect(outage).toMatchObject({ code: "JUDGE_UNAVAILABLE", retryable: true });
  });
});

describe("M6 → M3 results", () => {
  withM6("reads results produced by M6's executor", async () => {
    const { executeSubmission } = await import(new URL("judge/execute.ts", m6Src).href);
    const request = toJudgeSubmissionRequest(payload);
    // Fake sandbox: the program prints "True" for every test, so tc_2 is a wrong answer.
    const outcome = await executeSubmission({
      language: "python",
      sourceCode: request.sourceCode,
      pkg: request.judgePackage,
      limits: { cpuCores: 1, memoryLimitMb: 128, timeLimitMs: 2000 },
      run: async () => ({
        exitCode: 0,
        timedOut: false,
        stdout: Buffer.from("True\n"),
        stdoutExceeded: false,
        stderr: "",
        durationMs: 15,
      }),
    });

    const parsed = m6JudgeResultSchema.safeParse(m6Callback(outcome));
    expect(parsed.success).toBe(true);
    const mapped = fromM6JudgeResult(parsed.data!);

    expect(mapped).toMatchObject({
      submissionId: payload.submissionId,
      status: "completed",
      finalStatus: "WA",
      executionMs: 15,
    });
    expect(mapped.testResults).toEqual([
      { testCaseId: "tc_1", status: "AC", executionMs: 15, message: null, hidden: false },
      { testCaseId: "tc_2", status: "WA", executionMs: 15, message: null, hidden: true },
    ]);
  });

  it("maps a compile error and an execution failure", () => {
    const compileError = fromM6JudgeResult(
      m6JudgeResultSchema.parse(
        m6Callback({
          executionStatus: "completed",
          verdict: "CE",
          summary: { totalTests: 2, passedTests: 0, failedTests: 2 },
          metrics: { runtimeMs: 0 },
          diagnostics: { compileMessage: "main.cpp:1: error" },
        })
      )
    );
    expect(compileError).toMatchObject({ status: "completed", finalStatus: "CE", testResults: [] });

    const failed = fromM6JudgeResult(
      m6JudgeResultSchema.parse(
        m6Callback({ executionStatus: "failed", failure: { code: "RETRY_EXHAUSTED", retryable: false } })
      )
    );
    expect(failed).toMatchObject({ status: "failed", error: "RETRY_EXHAUSTED" });
  });

  it("rejects results that do not follow M6's contract", () => {
    expect(m6JudgeResultSchema.safeParse({ submissionId: "x", status: "completed" }).success).toBe(false);
    expect(m6JudgeResultSchema.safeParse(m6Callback({ executionStatus: "completed" })).success).toBe(false);
  });
});
