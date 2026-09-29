# Architecture

## Components

- Sync flow:

  ```
  Alert Source
      ↓
      API
      ↓
  Source Authentication
      ↓
  Alerts
      ├── Validate
      ├── Normalize
      ├── Identify
      └── Deduplicate
      ↓
  PostgreSQL transaction
      ├── Alert
      ├── Incident
      └── Outbox Event
      ↓
    Commit
      ↓
  HTTP Response
  ```

- Async flow:

  ```
    Outbox
      ↓
    BullMQ
      ↓
    Workers
    ├── AI triage
    ├── notifications
    ├── SLA/escalation
    └── postmortem
  ```

- Overall Flow:
  ```
                           ┌─────────────┐
                           │  Identity   │
                           └──────┬──────┘
                                  │
  Alert Source                    │
       │                          │
       ▼                          │
  ┌───────────┐                   │
  │  Alerts   │                   │
  │           │                   │
  │ normalize │                   │
  │ identify  │                   │
  │ dedup     │                   │
  └─────┬─────┘                   │
        │                         │
        │ ONE LOCAL TRANSACTION   │
        ▼                         │
  ┌───────────────────────────────┴──────┐
  │              PostgreSQL              │
  │                                      │
  │ Alert + Incident + Outbox            │
  └──────────────────┬───────────────────┘
                    │
                  COMMIT
                    │
                    ▼
                  BullMQ
                    │
        ┌───────────┼────────────┐
        │           │            │
        ▼           ▼            ▼
      AI Triage   SLA/          Notification
                  Escalation
        │           │
        │           └──→ notify escalation target
        │
        ▼
    Investigation /
    Postmortem
  ```

- Incident -> RESOLVED -> Postmortem Job -> AI -> Draft -> Human Review -> CLOSED.
- Modules: Identity, AppService, Alerts, Incident, Notifications, AI.
- External: Email provider, LLM provider.

---

## Module Responsibilities

| Module            | Owns                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| **Identity**      | Authentication, users, teams, roles, membership                                        |
| **AppService**    | Services, SLA configuration, escalation policy                                         |
| **Alerts**        | AlertSource, Alert, normalization, identity, deduplication, ingestion                  |
| **Incident**      | Incident lifecycle, severity, assignment, acknowledgement, resolution, comments, audit |
| **Notifications** | Notification records and delivery                                                      |
| **AI**            | Triage, investigation, evidence, postmortem generation/provenance                      |

---

## Concerns and Decisions

| Concern               | Decision                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scale Assumption      | Designed for 200 req/s on load test, it's a portfolio project                                                            |
| Deployment model      | Single containerized service + multi-worker process.                                                                     |
| App Hosting           | Everything on AWS post testing, testing with Supabase Postgres.                                                          |
| Database Access       | Using Prisma ORM. Raw SQL used for complex SQL queries.                                                                  |
| Reliability           | Notifications, escalations and assignment go through worker with retries and a fallback, not inline in the request path. |
| Security Boundaries   | Auth module owns identity; every other modules trust a verified request context.                                         |
| Data ownership        | One database; modules own their tables logically, not separated yet.                                                     |
| External dependencies | Email provider, LLM provider.                                                                                            |

---

## Database Connection Strategy (Supabase) - Testing

- Supabase fronts Postgres with a connection pooler (pgBouncer) exposed on two ports/modes. Which one to use depend on what's connecting:

| Use Case                        | Connection                                              | Why                                                                                                                      |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Running API and workers process | `DATABASE_URL` - Supabase transaction pooler, port 6543 | Lets many stateless app instances share a small real-backend connection budget. Does not support session-level features. |
| Running Migrations              | `DIRECT_URL` - Supabase direct connection, port 5432.   | DDL and multi-statement migration scripts need session-level semantics; safer and more predictable outside the pooler.   |
| Local Development               | `DIRECT_URL`                                            | Enough for code test and to check if app runs fine with few users.                                                       |

- The application's own `Pool` is set conservatively (eg. 5-10 per instance) even behind the transactional pooler - the pooler reduces backend connection pressure, it does not make the app's own pool unlimited. All non-local connections use SSL (`sslmode=requrie` minimum; Supabase requires TLS.)

---

## Flows

- **Synchronous Request Flow:** Alert Source -> API -> (Auth Verified) -> Alert module --AI Module--> Incident module -> Postmortem Module .  
  Request flows in each module as: Module -> Controller -> Service -> Repository -> PostgreSQL -> Response.

- **Asynchronous flow:** Service commits a state change -> publishes a job (notification, assignment, escalation, AI triage / postmortem) -> Workers dequeue from Redis -> call external provider -> writes result back through owning module's repository.

- **Alert flow:** Module receives the alerts from authenticated source, deduplicates it and calls incident module for new incident creation, if one doesn't exist.

- **Incident flow:** Module creates an incident, calls AI module for triage / severity detection, enqueues a worker for assignment, gets acknowledged by associated team member, severity confirmation, resolution and finally calls for postmortem draft generation. All state transition commit async notification to required stakeholders.

- **Notification Flow:**: Any module publishes a notification job after commit; worker sends via the email provider and records delivery status.

- **Failure/retry boundary:** All external calls (email provider, LLM provider) happen only inside the worker, never inline in an HTTP request, so a slow or down dependency cannot make an endpoint hang.

---

## ADRs (Architecture Decision Records)

### ADR-001: Modular monolith rather than microservices

| Status       | Accepted                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context      | The project has one team, no proven scale problem, and a bounded set of related workflows (auth -> alert -> incident -> notifications -> postmortem).                                                                                                                                                  |
| Decision     | Build one deployable service, internally organized into modules with clear boundaries and background workers - not microservices.                                                                                                                                                                      |
| Alternatives | Microservices per module.                                                                                                                                                                                                                                                                              |
| Rationale    | Microservices trade simplicity and fast deployment for independent scalability / deployability or fault tolerance - a trade that only pays off once a team or load pattern genuinely needs it. For a project of defined scale, that benefit becomes a bottleneck in quick development and maintenance. |
| Trade-offs   | Modules can't be deployed or scaled independently yet; fault tolerance is limited.                                                                                                                                                                                                                     |
| Consequences | A module boundary violation is a code-review problem now, not a network-enforced one; module discipline must be maintained by convention until/unless evidence justifies a split.                                                                                                                      |

### ADR-002: SQL DB over NoSQL DB

| Status       | Accepted                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | The project has multiple models with defined set of fields and relationship between them, with no flexibility requirements.                                    |
| Decision     | Use a SQL DB for well-defined schema and strong relationship between models.                                                                                   |
| Alternatives | Using a NoSQL DB (like MongoDB).                                                                                                                               |
| Rationale    | A relational database naturally fits the domain and simplifies referential integrity and multi-record transactions.                                            |
| Trade-offs   | Vertical scaling has a limit and migrations can get trickier when DB has millions of entry, plus a single point of failure.                                    |
| Consequences | Each data entry follows strict schema validation, relationships are strongly established and ACID transactions guarantee data consistency on high concurrency. |

### ADR-003: PostgreSQL over MySQL

| Status       | Accepted                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context      | The application needs to store data in a organized and well defined manner, primarily concurrent read and write operations.                                                                                                                                                          |
| Decision     | PostgreSQL as primary DB, the single source of truth.                                                                                                                                                                                                                                |
| Alternatives | MySQL                                                                                                                                                                                                                                                                                |
| Rationale    | PostgreSQL was selected because IMS is strongly relational and relies on ACID transactions, foreign keys, expressive SQL, row-level locking and predictable transactional semantics. It also provides a strong foundation for the project's future query and reporting requirements. |
| Trade-offs   | Scalability and setup is slightly complex than MySQL.                                                                                                                                                                                                                                |
| Consequences | Better concurrency control over atomic transaction and performance under load.                                                                                                                                                                                                       |

### ADR-004: Docker (containerized) over a binary application

| Status       | Accepted                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | IMS is a portfolio project, it needs to run across all OS smoothly, demanding environment consistency, dependencies management, faster deployment and easer rollback.                                                                                               |
| Decision     | Docker for containerization of application.                                                                                                                                                                                                                         |
| Alternatives | Binary process.                                                                                                                                                                                                                                                     |
| Rationale    | Docker provides a reproducible packaging and runtime environment, isolates user-space dependencies, simplifies local development and CI/CD, and produces portable OCI-compatible images that can be deployed across container runtimes and orchestration platforms. |
| Trade-offs   | Adds container/runtime/network/storage complexity compared with running a process directly on the host.                                                                                                                                                             |
| Consequences | Portability across the infrastructure, easier rollback to stable version of app and environment consistency across development, CI and deployment environments.                                                                                                     |

### ADR-005: Why Redis

| Status       | Accepted                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | IMS utilizes AI outputs in various ways for faster incident resolution and app improvements, which come at a genuine cost that must be minimized by avoiding LLM calls for same outputs. Moreover, it also needs rate limiting on alerts to not hammer the API past its limits and support workers queue durability. |
| Decision     | Using Redis for all 3 problems - caching, rate limiting and backing data store for workers.                                                                                                                                                                                                                          |
| Alternatives | Mem-cached / in-process memory for caching, process counters for rate limiting and RabbitMQ/ Postgres for workers store.                                                                                                                                                                                             |
| Rationale    | Redis is used for fast shared ephemeral state, rate limiting, caching, and BullMQ job management. PostgreSQL remains the durable source of truth, and the transactional outbox provides the durable handoff to asynchronous processing.                                                                              |
| Trade-offs   | Memcached is easier to setup, Postgres offers one dependency for all - but is not justified on scale. Introduces an additional availability dependency; Redis failure must be handled separately for cache, rate limiting and queue processing.                                                                      |
| Consequences | Redis enables efficient caching and rate limiting with proven methods and alternatives.                                                                                                                                                                                                                              |

### ADR-006: BullMQ over RabbitMQ / SQS

| Status       | Accepted                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | The async jobs needs workers to prevent blocking request, retry these operations in case of failures.                                                            |
| Decision     | BullMQ with Redis.                                                                                                                                               |
| Alternatives | RabbitMQ.                                                                                                                                                        |
| Rationale    | IMS needs background job processing rather than a general-purpose enterprise messaging topology, and Redis is already required for other shared-state workloads. |
| Trade-offs   | Single point of failure and moderate performance on load.                                                                                                        |
| Consequences | BullMQ uses Redis store for its workers to manage the async jobs such as escalation, AI calls, notifications.                                                    |

### ADR-007: AWS over Railway / Vercel

| Status       | Accepted                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context      | IMS is containerized application, made for portfolio. To make it publicly accessible, it needs to be deployed over cloud platforms.                                                        |
| Decision     | AWS deployment.                                                                                                                                                                            |
| Alternatives | Railway / Vercel                                                                                                                                                                           |
| Rationale    | AWS provides exposure to production-style cloud primitives relevant to backend engineering, including compute, container registries, networking, managed databases, IAM and observability. |
| Trade-offs   | Simpler setup with Railway.                                                                                                                                                                |
| Consequences | AWS handles the VMs / RDS / ECS / CloudWatch for IMS - enabling smooth scaling and maintenance once setup.                                                                                 |

### ADR-008: Notification - async with retries and exponential backoff + DLQ

| Status       | Accepted                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | Notifications jobs must be async and retries on failures with fallback, they are first source of info for stakeholders to know a service is down. |
| Decision     | Async notification retries with exponential backoff and DLQ after retry exhaustion.                                                               |
| Alternatives | Sync notifications.                                                                                                                               |
| Rationale    | Notifications must not block the request for jobs that need retries and don't affect the DB / app operations significantly.                       |
| Trade-offs   | Repetitive failures can prevent important messages to reach end user.                                                                             |
| Consequences | On failure limit, they need to be manually retried using DLQ.                                                                                     |

### ADR-009: Transactional Outbox for reliable async handoff

| Status       | Accepted                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | Incident state changes and asynchronous work must not become inconsistent.                                                             |
| Decision     | Persist the business state change and an outbox event in the same PostgreSQL transaction.                                              |
| Alternatives |                                                                                                                                        |
| Rationale    | It provides a durable handoff from: database state -> async processing, without pretending that the queue gives exactly once delivery. |
| Trade-offs   | Additional outbox table, publisher complexity, duplicate delivery remains possible, consumers must be idempotent.                      |
| Consequence  | Consistent incident state changes and async work.                                                                                      |

### ADR-010: Database-enforced concurrency for incident transitions

| Status       | Description                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | IMS necessitates the use of valid transitions, concurrent request handling using transaction / locking at DB layer.                                                                      |
| Decision     | DB-enforced concurrency using locking and transactions. A successful incident state transition, its audit event, and its required outbox event are committed atomically.                 |
| Alternatives | Read then write.                                                                                                                                                                         |
| Rationale    | The state machine is not merely an application-level if statement; the transition must be concurrency-safe at the persistence boundary. Using read then write, leads to malformed entry. |
| Trade-offs   | Increased response time, may affects connection pool limit on large scale.                                                                                                               |
| Consequence  | Invalid transitions prevented at application + DB layers.                                                                                                                                |

### ADR-011: Alert identity and deduplication

| Status       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | Alert module receives alerts, deduplicates it and calls incident module for new incident creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Decision     | Use the alert source plus a stable source-provided event identifier when available. Otherwise derive a deterministic fingerprint from identity-defining normalized fields. Enforce uniqueness at the database boundary. Alert ingestion consistency boundary: For a newly accepted, non-duplicate alert, the Alerts persistence workflow performs the creation of the Alert, initial Incident, and required Outbox event within one PostgreSQL transaction. Alert and Incident remain separate ownership boundaries; the transaction is an explicit cross-module consistency requirement of the current modular monolith. |
| Alternatives | Read then create.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Rationale    | Concurrent alerts must not lead to duplicate incident creation - using UNIQUE fingerprint + transaction. Using fields with possible changes over time and read-then-create leads to duplication.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Trade-offs   | Ensuring data correctness before a transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Consequence  | De-duplicated alerts and unique incident for same alerts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### ADR-012: AI is asynchronous and advisory

| Status       | Description                                                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | AI does NOT own incident correctness, it's a advisory mechanism for faster understanding of alert severity and possible causes.                                                                                                                                                                      |
| Decision     | Persist incident, then enqueue AI job.                                                                                                                                                                                                                                                               |
| Alternatives | AI as primary source of correctness.                                                                                                                                                                                                                                                                 |
| Rationale    | Trading incident persistence for alerts ASAP for AI-based suggestions and evaluation - is not justified if model takes longer time to response or is unavailable. Time is the key in the application, AI availability or latency must not block incident persistence or the core incident lifecycle. |
| Trade-offs   | Manual confirmation / default fallback needed - which may hamper the severity understanding and escalation rule initially.                                                                                                                                                                           |
| Consequence  | AI sends response asynchronously without blocking incident lifecycle.                                                                                                                                                                                                                                |

### ADR-013: AI provider abstraction

| Status       | Description                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | IMS needs LLM models for AI features, but not hardly coupled - given business cost and dynamics over time.                                                                                                                            |
| Decision     | Use an AI provider abstraction to create providers as per need and availability.                                                                                                                                                      |
| Alternatives | Specific LLM models.                                                                                                                                                                                                                  |
| Rationale    | LLM models limits change with time, so is the cost - IMS is a free-app demanding use of dependencies with free tiers, using specific LLMs leads to service unavailability after certain amount of time and needs significant changes. |
| Trade-offs   | Abstract overhead.                                                                                                                                                                                                                    |
| Consequence  | Easier switch to different models based on cost and availability.                                                                                                                                                                     |

### ADR-014: At-least-once processing with idempotent consumers

| Status       | Description                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | Multiple workers run simultaneously within app.                                                                                                                                                                                             |
| Decision     | Use at-least-once job delivery/processing semantics. Workers and business operations must be idempotent so that retries or duplicate delivery do not create duplicate business effects.                                                     |
| Alternatives | Enqueue and forget.                                                                                                                                                                                                                         |
| Rationale    | Jobs by workers must be executed once for resolution of incidents, even if it leads to execution more than once, which can be prevented idempotent business effect. Enqueue and forget doesn't guarantee delivery, which is not acceptable. |
| Trade-offs   | Worker pool exhaustion on load, idempotency overhead on service + DB layer.                                                                                                                                                                 |
| Consequence  | At-least-once job delivery/processing with idempotent business effects.                                                                                                                                                                     |

### ADR-015: SLA time model

| Status       | Description                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context      | SLA time model enables SLA tracking, escalation on breach, post-resolution behavior.                                                                                                                                                                                                                                                                  |
| Decision     | Use separate Response and Resolution SLA thresholds. Both SLA clocks start at incident.created_at. The latest incident severity determines the applicable SLA threshold during evaluation; severity changes do not reset the original clock. SLA warning occurs at 80% of the applicable window, and breach triggers the defined escalation behavior. |
| Alternatives | Single timer for both.                                                                                                                                                                                                                                                                                                                                |
| Rationale    | Response measures - `how quickly the incident is acknowledge` and Resolution measures `how quickly the incident is resolved.`                                                                                                                                                                                                                         |
| Trade-offs   | Overhead of timer management and more busy workers.                                                                                                                                                                                                                                                                                                   |
| Consequence  | Quick resolution and rightful attention of stakeholders due to severity based timer changes,                                                                                                                                                                                                                                                          |
