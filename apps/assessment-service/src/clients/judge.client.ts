/**
 * @file clients/judge.client.ts
 * @description HTTP client for the M6 Judge Service submission API (contract version 1.0).
 *
 * M6 contract (m6-judge/src/api/app.ts, m6-judge/src/domain/validate.ts):
 *   POST {JUDGE_API_URL}/internal/v1/judge-submissions
 *   Authorization: Bearer <service token with the `submit` scope>
 *   Idempotency-Key: <stable per submission>
 *   → 202 Accepted (or 200 on an idempotent replay) with { judgeSubmissionId, status }.
 * Results come back asynchronously on M3's POST /internal/v1/judge-results.
 */

import { env } from "../config/env";
import type { ProgrammingLanguage } from "../schemas/assessment.types";

export type JudgeComparisonMode = "exact" | "normalize_line_endings" | "trim_trailing_whitespace";

export interface JudgeTestCase {
  testCaseId: string;
  stdin: string;
  expectedOutput: string;
  visibility: "public" | "hidden";
}

export interface JudgeSubmissionRequest {
  contractVersion: "1.0";
  clientSubmissionId: string;
  attemptId: string;
  assessmentItemId: string;
  revision: number;
  language: ProgrammingLanguage;
  sourceCode: string;
  judgePackage: {
    packageId: string;
    version: number;
    comparisonMode: JudgeComparisonMode;
    testCases: JudgeTestCase[];
  };
  requestedRuntimeLimits?: {
    cpuCores: number;
    memoryLimitMb: number;
    timeLimitMs: number;
  };
}

export interface JudgeSubmissionAccepted {
  judgeSubmissionId: string;
  status: string;
}

export class JudgeClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "JudgeClientError";
  }
}

const TRACE_ID = /^[A-Za-z0-9-]{8,64}$/;

export class JudgeServiceClient {
  constructor(
    private readonly baseUrl: string | undefined = env.JUDGE_API_URL,
    private readonly token: string | undefined = env.JUDGE_API_TOKEN,
    private readonly timeoutMs: number = env.JUDGE_REQUEST_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async submit(
    request: JudgeSubmissionRequest,
    options: { idempotencyKey: string; traceId?: string }
  ): Promise<JudgeSubmissionAccepted> {
    if (!this.baseUrl || !this.token) {
      throw new JudgeClientError("Judge service is not configured", 0, "JUDGE_NOT_CONFIGURED", false);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/internal/v1/judge-submissions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "idempotency-key": options.idempotencyKey,
          ...(options.traceId && TRACE_ID.test(options.traceId) ? { "x-trace-id": options.traceId } : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "is unreachable";
      throw new JudgeClientError(`Judge service ${reason}`, 0, "JUDGE_UNAVAILABLE", true);
    }

    const body = (await response.json().catch(() => null)) as
      | { judgeSubmissionId?: string; status?: string; error?: { code?: string; message?: string; retryable?: boolean } }
      | null;

    if ((response.status === 202 || response.status === 200) && body?.judgeSubmissionId) {
      return { judgeSubmissionId: body.judgeSubmissionId, status: body.status ?? "queued" };
    }

    const retryable = body?.error?.retryable ?? (response.status === 429 || response.status >= 500);
    throw new JudgeClientError(
      body?.error?.message ?? `Judge service returned HTTP ${response.status}`,
      response.status,
      body?.error?.code ?? "JUDGE_ERROR",
      retryable
    );
  }
}

export const judgeClient = new JudgeServiceClient();
