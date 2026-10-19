# Incident Management System Backend

This backend service powers the incident management platform and follows a modular, layered architecture for maintainability and scalability.

## Project Structure

```text
incident-management-system/
├── README.md
├── docs/
│   ├── API.md
│   ├── Architecture.md
│   ├── Basic.md
│   ├── DB_Schema.md
│   ├── Domain_Model.md
│   └── PRD.md
│
├── frontend/
│   └── ...
│
└── backend/
    ├── Dockerfile
    ├── docker-compose.yml
    ├── eslint.config.mjs
    ├── jest.config.js
    ├── jest.int.config.js
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.build.json
    ├── README.md
    ├── prisma/
    │   ├── schema.prisma
    │   └── migrations/
    │
    ├── src/
    │   ├── app.ts
    │   ├── server.ts
    │   ├── config/
    │   │   └── env.ts
    │   │
    │   ├── infra/
    │   │   ├── db/
    │   │   ├── jobs/
    │   │   └── redis/
    │   │
    │   ├── modules/
    │   │   ├── aiService/
    │   │   ├── alerts/
    │   │   ├── appService/
    │   │   ├── auth/
    │   │   ├── incidents/
    │   │   ├── notifications/
    │   │   └── users/
    │   │
    │   ├── shared/
    │   │   ├── errors/
    │   │   │   └── AppError.ts
    │   │   ├── middleware/
    │   │   │   ├── error-mapping.ts
    │   │   │   └── request-ids.ts
    │   │   └── observability/
    │   │       └── logger.ts
    │   │
    │   ├── workers/
    │   └── tests/
    │       ├── factories/
    │       ├── helpers/
    │       └── integrations/
    │
    └── docs/
        ├── API-DESIGN-POSTMORTEM.md
        ├── API.md
        └── implementation-slices/
            ├── 00-INDEX.md
            ├── SLICE-01-identity-access.md
            ├── SLICE-02-service-catalog-sla-escalation-policy.md
            ├── SLICE-03-alert-source-trust-gate.md
            ├── SLICE-04-alert-ingestion-incident-creation.md
            ├── SLICE-05-incident-lifecycle-assignment.md
            ├── SLICE-06-incident-visibility-comments-timeline.md
            ├── SLICE-07-sla-monitoring-escalation.md
            ├── SLICE-08-outbox-queue-worker-reliability.md
            ├── SLICE-09-notifications.md
            ├── SLICE-10-ai-alert-triage.md
            ├── SLICE-11-postmortem-review-closure.md
            └── SLICE-12-ai-investigation-evaluation.md
```

## Module Architecture Pattern

Each module in `src/modules` follows a consistent layered structure to keep responsibilities clean and predictable.

```text
src/
└── modules/
    └── incidents/
        ├── index.ts                    # public interface; rest of the module is private
        ├── incidents.routes.ts         # route registration and endpoint definitions
        │
        ├── controllers/
        │   └── incidents.controller.ts # request/response handling
        │
        ├── services/
        │   └── incidents.service.ts    # orchestration and business logic
        │
        ├── repositories/
        │   └── incidents.repository.ts # persistence and data access
        │
        ├── schemas/
        │   └── incidents.schema.ts     # validation and DTO schemas
        │
        ├── types/
        │   ├── incidents.types.ts      # domain and model types
        │   └── incidents.response.ts   # response payload types
        │
        ├── mappers/
        │   └── incidents.mapper.ts     # entity/data transformation logic
        │
        └── tests/
            ├── incidents.service.test.ts
            ├── incidents.controller.test.ts
            └── incidents.integration.test.ts
```

Typical responsibilities by layer:

- `routes`: exposes endpoints and delegates to controllers
- `controllers`: validates HTTP request context and calls services
- `services`: contains business rules, orchestration, and domain logic
- `repositories`: talks to Prisma, databases, or external storage
- `schemas`: request validation, Zod or similar schema definitions
- `types`: domain models, payload contracts, and response structures
- `mappers`: converts persistence entities to domain objects or API responses
- `tests`: unit, controller, and integration coverage for the module

## Recommended Module Layout

Each feature module should follow the convention below:

```text
src/
└── modules/
    └── <module-name>/
        ├── index.ts
        ├── <module-name>.routes.ts
        ├── controllers/
        │   └── <module-name>.controller.ts
        ├── services/
        │   └── <module-name>.service.ts
        ├── repositories/
        │   └── <module-name>.repository.ts
        ├── schemas/
        │   └── <module-name>.schema.ts
        ├── types/
        │   ├── <module-name>.types.ts
        │   └── <module-name>.response.ts
        ├── mappers/
        │   └── <module-name>.mapper.ts
        └── tests/
            ├── <module-name>.service.test.ts
            ├── <module-name>.controller.test.ts
            └── <module-name>.integration.test.ts
```

This structure keeps each feature isolated, easy to test, and easier to extend as the platform grows.

Architecture
    - [ ✔️ ] Express vs NestJS frozen [Express chosen]
    - [ ✔️ ] Modular monolith frozen
    - [ ✔️ ] module boundary rule frozen
    - [ ✔️ ] Controller → Service → Repository frozen
    - [ ✔️ ] cross-module public-interface rule frozen
    - [ ✔️ ] app.ts / server.ts distinction frozen
    - [ ✔️ ] infrastructure boundary frozen

  Runtime
    - [ ✔️ ] Node.js
    - [ ✔️ ] TypeScript
    - [ ✔️ ] Express
    - [ ✔️ ] Zod
    - [ ✔️ ] Pino
    - [ ✔️ ] Jest
    - [ ✔️ ] Supertest

  Data
    - [ ✔️ ] PostgreSQL
    - [ ✔️ ] Prisma
    - [ ✔️ ] Prisma migration strategy
    - [ ✔️ ] transaction ownership rule
    - [ ✔️ ] DB constraint philosophy
    - [ ✔️ ] real PostgreSQL integration-test strategy

  Infrastructure
    - [ ✔️ ] Redis
    - [ ✔️ ] BullMQ
    - [ ✔️ ] Docker Compose
    - [ ✔️ ] environment configuration
    - [ ✔️ ] logging
    - [ ✔️ ] health/readiness

  Security
  - [ ✔️ ] JWT
  - [ ✔️ ] refresh session
  - [ ✔️ ] Argon2
  - [ ✔️ ] authorization boundary
  - [ ✔️ ] request context
  - [ ✔️ ] secret handling

Development workflow
    - [ ✔️ ] slice = persistent capability context
    - [ ✔️ ] implementation guide = execution process
    - [ ✔️ ] AGENTS = global agent rules
    - [ ✔️ ] PROJECT_STATE = current implementation state
    - [ ✔️ ] TEST_STATUS = evidence
    - [ ✔️ ] SESSION_CHECKPOINT = continuity
    - [ ✔️ ] no slice-specific implementation workflow duplication
    
  Repository
- [ ✔️ ] directory structure frozen
- [ ✔️ ] naming conventions frozen
- [ ✔️ ] module structure convention frozen
- [ ✔️ ] test structure frozen
- [ ✔️ ] config structure frozen
- [ ✔️ ] migration location frozen
