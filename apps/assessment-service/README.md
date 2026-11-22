# LurnKode – Assessment Microservice (M3)

Autonomous Assessment Microservice for the **LurnKode** AI-Assisted Learning Platform (CO3103).  
Responsible for assessment authoring, question banking, synchronous MCQ grading, asynchronous programming submission dispatching to the M6 Judge Worker, and domain event publishing.

---

## 🏗️ Architecture Overview

The Assessment Service runs as an independent, containerized service adopting the **Database-per-Service** pattern:
- **Runtime:** TypeScript on [Bun](https://bun.com)
- **Framework:** ElysiaJS REST API
- **Database:** Dedicated PostgreSQL instance (managed via Drizzle ORM)
- **Task Queue:** Redis + BullMQ (Producer for M6 Judge jobs)
- **Domain Events:** Emits `assessment.attempt.completed` events for M2 (Course Gradebook) & M4 (AI Tutor)
- **Inter-Service Client:** Resilient HTTP RPC client for M2 Course Enrollment checks

```
  API Gateway (M1) ──► Assessment Service (M3) ──► Dedicated PostgreSQL
                             │
                             ├──► M2 Course Service (Enrollment RPC)
                             ├──► Redis / BullMQ ──► M6 Judge Worker
                             └──► Publishes Domain Events (M2 & M4)
```

---

## 📁 Directory Structure

```
.
├── Dockerfile                         # Multi-stage production & dev Docker container
├── docker-compose.yml                 # Local multi-container setup (Service + Postgres + Redis)
├── package.json                       # Service dependencies and runner scripts
├── m3_assessment_module_tech_stack_data_flow_specification.md  # Architectural specification
├── scripts/
│   ├── fake-judge.ts                  # Mock judge worker simulating M6 callbacks
│   └── seed-assessment.ts             # Local database seeder
└── src/
    ├── config/                        # Environment config and Zod validation
    ├── db/                            # Dedicated Drizzle PostgreSQL schema & connection
    ├── clients/                       # Inter-service clients for M2 Course Service and M6 Judge Service
    ├── events/                        # Domain event definitions and publisher
    ├── middlewares/                   # Identity (M1 access tokens / gateway headers) & error handling
    ├── routes/                        # Elysia route controllers (Health, Instructor, Learner, Internal)
    ├── services/                      # Business logic, pure grading engines, queue & callback services
    ├── repositories/                  # Drizzle repository operations
    ├── schemas/                       # Domain types and Zod contract schemas
    ├── mappers/                       # Safe data mappers (sanitizing learner-visible payloads)
    ├── tests/                         # Unit tests (grading math) and integration tests
    └── index.ts                       # Service bootstrap & port listener
```

---

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.com) v1.2+
- Docker & Docker Compose (optional for local containerized environment)

### Installation
```bash
bun install
```

### Running Tests
```bash
bun test
```

### Local Development
```bash
# Start standalone dev server with live reload:
bun run dev

# Or spin up full containerized stack (Service + Dedicated Postgres + Redis):
docker compose up -d
```

The container joins the main stack's `lurnkode-network` to reach M1/M2 at `http://api:8000`,
so start the main stack first (`docker compose up -d` in the repository root), or create the
network once with `docker network create lurnkode-network` to run M3 on its own.

### Seeding Test Data
```bash
bun run seed
```

### Authentication

Callers send the access token they got from M1 (`POST /api/v1/auth/login`).
M3 verifies it against M1's JWKS (`M1_JWKS_URL`) or public key (`JWT_PUBLIC_KEY`),
including issuer and audience, and reads the user id (`sub`) and role (`role`).
M1's roles `Learner` / `Instructor` / `Admin` are accepted in any letter case.

```bash
-H "Authorization: Bearer $M1_ACCESS_TOKEN"
```

With a token, M3 also asks M2 on the caller's behalf:
- starting an attempt checks the learner's enrollment (`GET /api/v1/my/enrollments`);
- authoring checks that the instructor owns the course (`GET /api/v1/courses/:id`; admins may manage any course).

Gateway headers are accepted only when `TRUST_GATEWAY_HEADERS=true`, which is the
default outside production (local demos, tests) and off in production:

```bash
-H "X-User-Id: instructor-1" -H "X-User-Role: instructor"
-H "X-User-Id: learner-1" -H "X-User-Role: learner"
```

Header identity carries no token, so the M2 course-ownership check is skipped and
enrollment uses M2's internal endpoint (`/internal/courses/:courseId/enrollments/:userId`,
not implemented by M2 yet; development mode falls back to allowing the learner).

Requests without an identity fail with `401`; a valid identity with the wrong
role fails with `403`. There is no development-user fallback.

### Judging code (M6)

Set `JUDGE_API_URL` and `JUDGE_API_TOKEN` to send submissions to M6's
`POST /internal/v1/judge-submissions` (contract 1.0). M6 posts results back to
`POST /internal/v1/judge-results` with `Authorization: Bearer $JUDGE_CALLBACK_TOKEN`
(M6's `CALLBACK_TOKEN`), so point M6's `CALLBACK_URL` at that route.

- Languages: `python` and `cpp` (what M6 runs).
- Programs read each test's `input` on stdin; stdout is compared with `expectedOutput`
  ignoring trailing whitespace.
- Limits may not exceed M6's ceilings: 1 CPU, 128 MB, 3000 ms.

Without `JUDGE_API_URL`, development keeps a local stub and results can be
simulated with `bun run fake-judge <submissionId>`, which uses M3's own callback
(`POST /internal/judge/callback`, `X-Internal-Token: $INTERNAL_SERVICE_TOKEN`).
In production, code submissions are refused until the judge is configured.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health/live` | Service liveness probe |
| `GET` | `/health/ready` | Service readiness probe (checks DB & Redis) |
| `POST` | `/instructor/assessments` | Create assessment (Draft) |
| `POST` | `/instructor/assessments/:id/items` | Add MCQ or Programming question |
| `POST` | `/instructor/assessments/:id/publish` | Publish assessment |
| `POST` | `/learner/assessments/:id/attempts` | Start attempt (queries M2 for enrollment) |
| `POST` | `/learner/attempts/:attemptId/answers` | Submit synchronous MCQ answer |
| `POST` | `/learner/attempts/:attemptId/code-submissions`| Submit code for async judge evaluation |
| `POST` | `/learner/attempts/:attemptId/finish` | Finish attempt (`grading` if judge jobs pending, otherwise `completed` + event) |
| `POST` | `/internal/v1/judge-results` | Result callback from the M6 Judge Service (Bearer `JUDGE_CALLBACK_TOKEN`) |
| `POST` | `/internal/judge/callback` | M3-format judge callback used by `scripts/fake-judge.ts` |
