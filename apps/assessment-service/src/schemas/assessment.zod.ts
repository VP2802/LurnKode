import { z } from "zod";

/**
 * Common primitives
 */
export const uuidSchema = z.string().uuid();

export const assessmentStatusSchema = z.enum(["draft", "published", "archived"]);
export const assessmentItemTypeSchema = z.enum(["mcq", "programming"]);
export const mcqSelectionTypeSchema = z.enum(["single", "multiple"]);
export const attemptStatusSchema = z.enum(["in_progress", "submitted", "grading", "completed", "failed"]);
export const judgeVerdictSchema = z.enum(["AC", "WA", "TLE", "MLE", "RE", "RTE", "CE"]);
/** Languages the M6 judge can run (m6-judge/src/domain/validate.ts). */
export const programmingLanguageSchema = z.enum(["python", "cpp"]);

/**
 * MCQ payload schema
 */
export const mcqOptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const mcqPayloadSchema = z
  .object({
    mcqType: mcqSelectionTypeSchema,
    options: z.array(mcqOptionSchema).min(2),
    correctOptionIds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((payload, ctx) => {
    const optionIds = new Set(payload.options.map((option) => option.id));

    if (optionIds.size !== payload.options.length) {
      ctx.addIssue({
        code: "custom",
        message: "MCQ option IDs must be unique",
        path: ["options"],
      });
    }

    for (const correctId of payload.correctOptionIds) {
      if (!optionIds.has(correctId)) {
        ctx.addIssue({
          code: "custom",
          message: `Correct option '${correctId}' does not exist in options`,
          path: ["correctOptionIds"],
        });
      }
    }

    if (payload.mcqType === "single" && payload.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Single-choice questions must have exactly one correct option",
        path: ["correctOptionIds"],
      });
    }

    if (new Set(payload.correctOptionIds).size !== payload.correctOptionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "Correct option IDs must be unique",
        path: ["correctOptionIds"],
      });
    }
  });

/**
 * Programming payload schema
 */
export const testCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  expectedOutput: z.string(),
  hidden: z.boolean().default(true),
  weight: z.number().positive().default(1),
});

/** Upper bounds are M6's sandbox policy ceilings; M6 rejects requests above them. */
export const executionLimitsSchema = z.object({
  cpu: z.number().positive().max(1).default(1),
  memoryMb: z.number().positive().max(128).default(128),
  timeoutMs: z.number().int().positive().max(3000).default(3000),
});

export const programmingPayloadSchema = z.object({
  language: programmingLanguageSchema,
  starterCode: z.string().optional(),
  solution: z.string().optional(),
  hiddenTestCases: z.array(testCaseSchema).min(1),
  limits: executionLimitsSchema.default({ cpu: 1, memoryMb: 128, timeoutMs: 3000 }),
});

/**
 * Request Schemas: Instructor
 */
export const createAssessmentSchema = z.object({
  courseId: z.string().min(1),
  title: z.string().min(3).max(255),
  description: z.string().max(2000).optional(),
  maxAttempts: z.number().int().positive().default(3),
  timeLimitSec: z.number().int().positive().optional(),
});

export const updateAssessmentSchema = createAssessmentSchema.partial();

export const createAssessmentItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mcq"),
    title: z.string().min(3).max(255),
    prompt: z.string().min(1),
    points: z.number().positive(),
    sortOrder: z.number().int().nonnegative().default(0),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    tags: z.array(z.string()).optional(),
    mcqPayload: mcqPayloadSchema,
  }),
  z.object({
    type: z.literal("programming"),
    title: z.string().min(3).max(255),
    prompt: z.string().min(1),
    points: z.number().positive(),
    sortOrder: z.number().int().nonnegative().default(0),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    tags: z.array(z.string()).optional(),
    programmingPayload: programmingPayloadSchema,
  }),
]);

/**
 * Request Schemas: Learner
 */
export const submitMcqAnswerSchema = z.object({
  itemId: z.string().min(1),
  selectedOptionIds: z.array(z.string().min(1)),
});

export const submitCodeSchema = z.object({
  itemId: z.string().min(1),
  language: programmingLanguageSchema,
  sourceCode: z.string().min(1).max(65536),
});

/**
 * Inter-Service Contracts
 */
export const judgeCallbackSchema = z
  .object({
    submissionId: z.string().min(1),
    judgeJobId: z.string().optional().nullable(),
    status: z.enum(["completed", "failed"]),
    finalStatus: judgeVerdictSchema.optional(),
    error: z.string().optional().nullable(),
    executionMs: z.number().nonnegative().default(0),
    memoryKb: z.number().nonnegative().default(0),
    testResults: z
      .array(
        z.object({
          testCaseId: z.string().min(1),
          status: judgeVerdictSchema,
          executionMs: z.number().nonnegative().default(0),
          message: z.string().optional().nullable(),
          hidden: z.boolean().default(true),
        })
      )
      .default([]),
  })
  .superRefine((payload, ctx) => {
    if (payload.status === "completed") {
      if (!payload.finalStatus) {
        ctx.addIssue({
          code: "custom",
          message: "finalStatus is required when status is 'completed'",
          path: ["finalStatus"],
        });
      }
      if (payload.testResults.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "testResults must not be empty when status is 'completed'",
          path: ["testResults"],
        });
      }
    }

    if (payload.status === "failed" && !payload.error) {
      ctx.addIssue({
        code: "custom",
        message: "error is required when status is 'failed'",
        path: ["error"],
      });
    }

    const testCaseIds = payload.testResults.map((result) => result.testCaseId);
    if (new Set(testCaseIds).size !== testCaseIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "testResults must not contain duplicate testCaseId values",
        path: ["testResults"],
      });
    }
  });

/**
 * Result callback sent by the M6 Judge Service (contract version 1.0,
 * m6-judge/src/db/store.ts `completeSubmission`). Unknown fields are ignored.
 */
export const m6JudgeResultSchema = z
  .object({
    contractVersion: z.literal("1.0"),
    eventId: z.string().min(1),
    judgeSubmissionId: z.string().min(1),
    clientSubmissionId: z.string().min(1),
    executionStatus: z.enum(["completed", "failed"]),
    verdict: z.enum(["AC", "WA", "TLE", "RTE", "CE"]).optional(),
    summary: z
      .object({
        totalTests: z.number().int().nonnegative(),
        passedTests: z.number().int().nonnegative(),
        failedTests: z.number().int().nonnegative(),
      })
      .optional(),
    metrics: z.object({ runtimeMs: z.number().nonnegative().optional() }).optional(),
    diagnostics: z
      .object({
        compileMessage: z.string().nullable().optional(),
        tests: z
          .array(
            z.object({
              testCaseId: z.string().min(1),
              visibility: z.enum(["public", "hidden"]).default("hidden"),
              verdict: z.enum(["AC", "WA", "TLE", "RTE"]),
              runtimeMs: z.number().nonnegative().default(0),
            })
          )
          .optional(),
      })
      .optional(),
    failure: z.object({ code: z.string().min(1), retryable: z.boolean().optional() }).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.executionStatus === "completed" && !payload.verdict) {
      ctx.addIssue({ code: "custom", message: "verdict is required when executionStatus is 'completed'", path: ["verdict"] });
    }
    if (payload.executionStatus === "failed" && !payload.failure) {
      ctx.addIssue({ code: "custom", message: "failure is required when executionStatus is 'failed'", path: ["failure"] });
    }
  });

export type M6JudgeResult = z.infer<typeof m6JudgeResultSchema>;

/** Maps an M6 result onto M3's judge callback input. */
export function fromM6JudgeResult(result: M6JudgeResult): JudgeCallbackInput {
  if (result.executionStatus === "failed") {
    return {
      submissionId: result.clientSubmissionId,
      judgeJobId: result.judgeSubmissionId,
      status: "failed",
      error: result.failure?.code ?? "JUDGE_FAILED",
      executionMs: 0,
      memoryKb: 0,
      testResults: [],
    };
  }

  return {
    submissionId: result.clientSubmissionId,
    judgeJobId: result.judgeSubmissionId,
    status: "completed",
    finalStatus: result.verdict,
    error: null,
    executionMs: result.metrics?.runtimeMs ?? 0,
    memoryKb: 0, // M6 does not report memory usage
    testResults: (result.diagnostics?.tests ?? []).map((test) => ({
      testCaseId: test.testCaseId,
      status: test.verdict,
      executionMs: test.runtimeMs,
      message: null,
      hidden: test.visibility !== "public",
    })),
  };
}

export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;
export type CreateAssessmentItemInput = z.infer<typeof createAssessmentItemSchema>;
export type SubmitMcqAnswerInput = z.infer<typeof submitMcqAnswerSchema>;
export type SubmitCodeInput = z.infer<typeof submitCodeSchema>;
export type JudgeCallbackInput = z.infer<typeof judgeCallbackSchema>;

