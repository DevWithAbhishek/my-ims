# Defining and Measuring IMS Metrics

Yes—you can define meaningful, defensible metrics for IMS without real users. **Load testing can validate performance and reliability under a simulated workload.** It cannot prove real adoption, user satisfaction, or business impact.

The key distinction is:

- **PRD target:** What the system should achieve.
- **Test result:** What you measured in a specific test environment.
- **Real-world outcome:** What happened after actual users adopted the system.

Don’t write a target into your resume later as if it were a measured result.

## 1. Put measurable targets in the PRD

For IMS, define a small set of measurable non-functional requirements (NFRs). The values below are **illustrative starting targets**, not industry standards or results. Adjust them after establishing a baseline and considering the expected workload.

| Area | Example PRD requirement | How to verify |
|---|---|---|
| API latency | 95% of incident-list requests complete within 300 ms under the defined test load | k6 response-time percentiles |
| Error rate | Fewer than 1% failed requests during the steady-state load test | k6 checks and HTTP status counts |
| Throughput | Sustain 50 requests/second for 10 minutes with the latency and error targets met | k6 |
| Concurrency | Support 100 simulated virtual users performing the defined workflows | k6 |
| SLA escalation | An overdue incident is escalated within 60 seconds of its configured threshold | Integration test with controlled time; worker logs |
| Background jobs | 99% of queued notification jobs begin processing within 10 seconds under the test workload | Queue timestamps and worker metrics |
| Data correctness | No duplicate escalation or notification records when the same job is delivered more than once | Automated duplicate-delivery test |
| Recovery | After the worker restarts, pending jobs resume without losing or duplicating completed work | Failure-injection test |

The numbers should be tied to a **workload definition**. “100 concurrent users” means little unless you specify what they do, how often they act, how long the test runs, and what data size is loaded.

## 2. Design a realistic synthetic workload

For IMS, create a few representative user journeys:

1. An engineer signs in and views assigned incidents.
2. An engineer creates or updates an incident.
3. An incident changes status and triggers a notification job.
4. A manager views incidents by status, priority, or SLA.
5. A background worker processes overdue incidents and performs escalation.

Use k6 to simulate those workflows with generated test accounts and data. Include a ramp-up, a steady-state period, and a ramp-down. Test more than one load level rather than selecting a single impressive number.

For example:

- **Baseline:** 5–10 virtual users
- **Normal test:** 25–50 virtual users
- **Higher-load test:** 100 virtual users
- **Stress test:** Increase load until latency or errors breach your target

These are test stages you could choose—not claims about IMS capacity.

## 3. Record the conditions, not just the headline number

A defensible test result should include:

- Test date and code version
- Environment and instance size
- Database and dataset size
- k6 script and workload mix
- Virtual users, request rate, and test duration
- p50, p95, and p99 latency
- Error rate and failed checks
- Database CPU/connections or slow queries, where available
- Queue depth, processing delay, retries, and failures
- Any bottleneck or limitation discovered

A result such as “100 virtual users” is incomplete without the test duration, workload, error rate, and latency.

## 4. What to put in the PRD versus the resume

### In the PRD

Write requirements as targets:

> **NFR-PERF-01:** Under the defined 50-requests/second workload, 95% of incident-list requests must complete within 300 ms, with an HTTP error rate below 1%.

Then add acceptance criteria describing the test that will determine whether the target is met.

### After testing

Report the actual result—even if it misses the target:

> In a k6 test with 50 virtual users over 10 minutes, incident-list requests had a p95 latency of **[measured value]**, with **[measured error rate]** failed requests. The test exposed **[observed bottleneck]**.

Replace every bracket with a real measurement. If the target was missed, document what you investigated and changed.

### On your resume, once verified

A defensible format would be:

> Load-tested the IMS incident APIs using k6 with **[N] virtual users** over **[duration]**, measuring **[p95 latency]** and **[error rate]**; identified and addressed **[specific bottleneck]**.

Do **not** convert simulated users into “real users,” or claim “reduced incident-resolution time” unless you measured that outcome with real operational data.

## 5. Metrics you cannot honestly establish yet

Without real users or operational deployment, you cannot substantiate claims such as:

- Improved employee productivity by 30%
- Reduced incident-resolution time by 40%
- Increased user adoption
- Improved customer satisfaction
- Reduced production incidents

You can define these as **future product outcome metrics** in the PRD, then measure them after deployment using a suitable baseline and real usage data.

For now, measure what you can control: **latency, throughput, error rate, data correctness, queue delay, retry behavior, and recovery.** Those are real engineering metrics, even when generated through synthetic tests.

One important project-specific point: since IMS has not been started, treat all of the above as **proposed requirements and a test plan**. They become accomplishments only after you implement the relevant system, run the tests, and record the actual results.