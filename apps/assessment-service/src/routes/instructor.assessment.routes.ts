/**
 * @file routes/instructor.assessment.routes.ts
 * @description HTTP route controllers for instructor assessment authoring.
 *
 * Identity:
 * - An M1 access token (Authorization: Bearer), or trusted gateway headers (X-User-Id / X-User-Role).
 * - Enforces instructor/admin role before any authoring operation.
 * - With a token, M2 confirms the caller owns the course (admins may manage any course).
 */

import { Elysia } from "elysia";
import { assessmentService } from "../services/assessment.service";
import { createAssessmentSchema, createAssessmentItemSchema } from "../schemas/assessment.zod";
import { requireRole } from "../middlewares/auth.middleware";
import { handleRouteError } from "../middlewares/error.middleware";

const INSTRUCTOR_ROLES = ["instructor", "admin"] as const;

export const instructorRoutes = new Elysia({ prefix: "/instructor/assessments" })
  .post("/", async ({ body, headers, set }) => {
    try {
      const user = await requireRole(headers, INSTRUCTOR_ROLES);

      const parsed = createAssessmentSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "Validation Error", details: parsed.error.format() };
      }
      await assessmentService.assertCanManageCourse(parsed.data.courseId, user);

      const assessment = await assessmentService.createAssessment(parsed.data);
      set.status = 201;
      return assessment;
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  })
  .get("/:id", async ({ params: { id }, headers, set }) => {
    try {
      const user = await requireRole(headers, INSTRUCTOR_ROLES);

      const assessment = await assessmentService.getManagedAssessment(id, user);
      const items = await assessmentService.listItems(id);
      return { ...assessment, items };
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  })
  .post("/:id/publish", async ({ params: { id }, headers, set }) => {
    try {
      const user = await requireRole(headers, INSTRUCTOR_ROLES);
      await assessmentService.getManagedAssessment(id, user);

      const published = await assessmentService.publishAssessment(id);
      return published;
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  })
  .post("/:id/items", async ({ params: { id }, body, headers, set }) => {
    try {
      const user = await requireRole(headers, INSTRUCTOR_ROLES);

      const parsed = createAssessmentItemSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "Validation Error", details: parsed.error.format() };
      }
      await assessmentService.getManagedAssessment(id, user);

      const item = await assessmentService.addItem(id, parsed.data);
      set.status = 201;
      return item;
    } catch (err: unknown) {
      return handleRouteError(err, set);
    }
  });
