/**
 * @file services/queue.service.ts
 * @description Dispatches code submissions to the M6 Judge Service.
 *
 * - With JUDGE_API_URL / JUDGE_API_TOKEN set, submissions go to M6 over its HTTP API
 *   (M6 owns the queue, sandbox and retries) and results return on /internal/v1/judge-results.
 * - Without them, development/test keeps a local stub: the job id is generated here and a
 *   result can be simulated with scripts/fake-judge.ts. Production refuses code submissions.
 */

import { judgeClient, JudgeClientError, JudgeServiceClient, type JudgeSubmissionRequest } from "../clients/judge.client";
import { env } from "../config/env";
import { ServiceError } from "../middlewares/error.middleware";
import type { AssessmentItem, ProgrammingLanguage } from "../schemas/assessment.types";

export interface JudgeJobPayload {
  submissionId: string;
  attemptId: string;
  /** Programming item being answered (must carry a programmingPayload). */
  item: AssessmentItem;
  /** 1 for the first submission of this item in the attempt, 2 for the next, ... */
  revision: number;
  language: ProgrammingLanguage;
  sourceCode: string;
  correlationId?: string;
}

/** Maps an M3 code submission onto M6's judge submission contract (v1.0). */
export function toJudgeSubmissionRequest(payload: JudgeJobPayload): JudgeSubmissionRequest {
  const programming = payload.item.programmingPayload;
  if (!programming) {
    throw new ServiceError(400, "INVALID_PROGRAMMING_ITEM", "Programming item has no payload");
  }

  return {
    contractVersion: "1.0",
    clientSubmissionId: payload.submissionId,
    attemptId: payload.attemptId,
    assessmentItemId: payload.item.id,
    revision: payload.revision,
    language: payload.language,
    sourceCode: payload.sourceCode,
    judgePackage: {
      packageId: payload.item.id,
      // Changes whenever the item (and so its test cases) changes.
      version: Math.max(1, Math.floor(new Date(payload.item.updatedAt).getTime() / 1000)),
      comparisonMode: "trim_trailing_whitespace",
      testCases: programming.hiddenTestCases.map((testCase) => ({
        testCaseId: testCase.id,
        stdin: testCase.input,
        expectedOutput: testCase.expectedOutput,
        visibility: testCase.hidden ? "hidden" : "public",
      })),
    },
    requestedRuntimeLimits: {
      cpuCores: programming.limits.cpu,
      memoryLimitMb: programming.limits.memoryMb,
      timeLimitMs: programming.limits.timeoutMs,
    },
  };
}

export class QueueService {
  constructor(private judge: JudgeServiceClient = judgeClient) {}

  /**
   * Sends a code submission to M6 and returns M6's judge submission id
   * (stored as the submission's judgeJobId).
   */
  async enqueueJudgeJob(payload: JudgeJobPayload): Promise<string> {
    if (!this.judge.configured) {
      if (env.NODE_ENV === "production") {
        throw new ServiceError(
          503,
          "JUDGE_NOT_CONFIGURED",
          "Code grading is unavailable: the judge service is not configured"
        );
      }
      const jobId = `job_${crypto.randomUUID()}`;
      console.info(
        `[QueueService] Judge not configured; local stub job ${jobId} for submission ${payload.submissionId} ` +
          "(simulate a result with scripts/fake-judge.ts)"
      );
      return jobId;
    }

    try {
      const accepted = await this.judge.submit(toJudgeSubmissionRequest(payload), {
        idempotencyKey: payload.submissionId,
        traceId: payload.correlationId,
      });
      console.info(
        `[QueueService] Submitted ${payload.submissionId} to M6 as ${accepted.judgeSubmissionId} (${accepted.status})`
      );
      return accepted.judgeSubmissionId;
    } catch (err: unknown) {
      if (err instanceof JudgeClientError) {
        throw new ServiceError(
          err.retryable ? 503 : 502,
          err.retryable ? "JUDGE_UNAVAILABLE" : "JUDGE_REJECTED",
          err.retryable
            ? "The judge service is unavailable; please resubmit shortly"
            : `The judge service rejected the submission (${err.code})`,
          { judgeStatus: err.status, judgeCode: err.code }
        );
      }
      throw err;
    }
  }
}

export const queueService = new QueueService();
