/**
 * @file services/assessment.service.ts
 * @description Core business logic for assessment authoring, publishing, and question banking.
 */

import { courseClient, CourseServiceClient, type CourseAccessResult } from "../clients/course.client";
import { assessmentRepository, AssessmentRepository } from "../repositories/assessment.repository";
import { ServiceError } from "../middlewares/error.middleware";
import type { UserContext } from "../middlewares/auth.middleware";
import type { Assessment, AssessmentItem } from "../schemas/assessment.types";
import type { CreateAssessmentInput, CreateAssessmentItemInput } from "../schemas/assessment.zod";

export class AssessmentService {
  constructor(
    private repo: AssessmentRepository = assessmentRepository,
    private m2Client: CourseServiceClient = courseClient
  ) {}

  /**
   * Ensures the caller owns the M2 course (or is an admin) before authoring for it.
   * Needs the caller's M1 access token so M2 can answer for that caller; identity that
   * came from trusted gateway headers carries no token, and the check is skipped.
   */
  async assertCanManageCourse(courseId: string, user: UserContext): Promise<void> {
    if (!user.accessToken) return;

    let access: CourseAccessResult;
    try {
      access = await this.m2Client.checkCourseAccess(courseId, user.userId, user.role, {
        accessToken: user.accessToken,
        correlationId: user.correlationId,
      });
    } catch (err: unknown) {
      throw new ServiceError(
        503,
        "M2_UNAVAILABLE",
        "Course ownership could not be verified; please retry shortly",
        err instanceof Error ? err.message : undefined
      );
    }

    if (!access.exists) {
      throw new ServiceError(404, "COURSE_NOT_FOUND", `Course ${courseId} was not found in the course service`);
    }
    if (!access.canManage) {
      throw new ServiceError(403, "NOT_COURSE_OWNER", "You do not own this course");
    }
  }

  /** Loads an assessment and checks the caller may manage its course. */
  async getManagedAssessment(id: string, user: UserContext): Promise<Assessment> {
    const assessment = await this.repo.findAssessmentById(id);
    if (!assessment) {
      throw new ServiceError(404, "ASSESSMENT_NOT_FOUND", "Assessment not found");
    }
    await this.assertCanManageCourse(assessment.courseId, user);
    return assessment;
  }

  async createAssessment(input: CreateAssessmentInput & { id?: string }): Promise<Assessment> {
    return this.repo.createAssessment({
      ...(input.id ? { id: input.id } : {}),
      courseId: input.courseId,
      title: input.title,
      description: input.description,
      status: "draft",
      maxAttempts: input.maxAttempts,
      timeLimitSec: input.timeLimitSec,
      publishedAt: null,
    });
  }

  async getAssessment(id: string): Promise<Assessment | null> {
    return this.repo.findAssessmentById(id);
  }

  async listAssessmentsByCourse(courseId: string): Promise<Assessment[]> {
    return this.repo.listAssessmentsByCourse(courseId);
  }

  async listItems(assessmentId: string): Promise<AssessmentItem[]> {
    return this.repo.listItemsByAssessmentId(assessmentId);
  }

  async addItem(
    assessmentId: string,
    input: CreateAssessmentItemInput & { id?: string }
  ): Promise<AssessmentItem> {
    const assessment = await this.repo.findAssessmentById(assessmentId);
    if (!assessment) {
      throw new ServiceError(404, "ASSESSMENT_NOT_FOUND", "Assessment not found");
    }
    if (assessment.status !== "draft") {
      throw new ServiceError(
        409,
        "ASSESSMENT_NOT_EDITABLE",
        "Cannot add items to a published or archived assessment"
      );
    }

    if (input.type === "mcq") {
      return this.repo.createItem({
        ...(input.id ? { id: input.id } : {}),
        assessmentId,
        type: "mcq",
        title: input.title,
        prompt: input.prompt,
        points: input.points,
        sortOrder: input.sortOrder,
        difficulty: input.difficulty,
        tags: input.tags,
        mcqPayload: input.mcqPayload,
      });
    } else {
      return this.repo.createItem({
        ...(input.id ? { id: input.id } : {}),
        assessmentId,
        type: "programming",
        title: input.title,
        prompt: input.prompt,
        points: input.points,
        sortOrder: input.sortOrder,
        difficulty: input.difficulty,
        tags: input.tags,
        programmingPayload: input.programmingPayload,
      });
    }
  }

  async publishAssessment(id: string): Promise<Assessment> {
    const assessment = await this.repo.findAssessmentById(id);
    if (!assessment) {
      throw new ServiceError(404, "ASSESSMENT_NOT_FOUND", "Assessment not found");
    }
    if (assessment.status === "published") return assessment;

    const items = await this.repo.listItemsByAssessmentId(id);
    if (items.length === 0) {
      throw new ServiceError(
        409,
        "ASSESSMENT_HAS_NO_ITEMS",
        "Cannot publish an assessment with zero questions"
      );
    }

    const updated = await this.repo.updateAssessment(id, {
      status: "published",
      publishedAt: new Date(),
    });
    if (!updated) {
      throw new ServiceError(500, "ASSESSMENT_UPDATE_FAILED", "Failed to update assessment status");
    }
    return updated;
  }
}

export const assessmentService = new AssessmentService();

