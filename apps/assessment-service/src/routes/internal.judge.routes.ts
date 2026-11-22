/**
 * @file routes/internal.judge.routes.ts
 * @description Internal HTTP routes for receiving judge execution results.
 *
 * - POST /internal/v1/judge-results — M6 Judge Service result callback (contract v1.0).
 *   Auth: `Authorization: Bearer <JUDGE_CALLBACK_TOKEN>`. M6 delivers at least once and
 *   treats 2xx as delivered, 408/429/5xx as retry, other 4xx as permanently rejected.
 * - POST /internal/judge/callback — M3's own callback format (scripts/fake-judge.ts).
 *   Auth: X-Internal-Token / X-Internal-Service-Key matching INTERNAL_SERVICE_TOKEN.
 *
 * Both are idempotent: a repeated result for a judged submission changes nothing.
 */

import { Elysia } from "elysia";
import { callbackService } from "../services/callback.service";
import { fromM6JudgeResult, judgeCallbackSchema, m6JudgeResultSchema } from "../schemas/assessment.zod";
import { verifyInternalToken, verifyJudgeCallbackToken } from "../middlewares/auth.middleware";
import { handleRouteError } from "../middlewares/error.middleware";

export const internalJudgeRoutes = new Elysia({ prefix: "/internal" })
  .post("/v1/judge-results", async ({ headers, body, set }) => {
    if (!verifyJudgeCallbackToken(headers)) {
      set.status = 401;
      return { error: "Unauthorized: invalid judge callback token" };
    }

    const parsed = m6JudgeResultSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 422;
      return { error: "Invalid judge result payload", details: parsed.error.format() };
    }

    try {
      const result = await callbackService.processJudgeCallback(fromM6JudgeResult(parsed.data), {
        requireMatchingJudgeJob: true,
      });
      set.status = 200;
      return {
        status: "success",
        eventId: parsed.data.eventId,
        submissionId: result.submission.id,
        idempotent: result.idempotent,
      };
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  })
  .post("/judge/callback", async ({ headers, body, set }) => {
    // 1. Verify internal service authentication (supports X-Internal-Service-Key and X-Internal-Token)
    if (!verifyInternalToken(headers)) {
      set.status = 401;
      return { error: "Unauthorized: Invalid internal service token" };
    }

    // 2. Validate payload contract
    const parsed = judgeCallbackSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: "Invalid judge callback payload", details: parsed.error.format() };
    }

    try {
      const result = await callbackService.processJudgeCallback(parsed.data);
      set.status = 200;
      return {
        status: "success",
        submissionId: result.submission.id,
        idempotent: result.idempotent,
      };
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  });
