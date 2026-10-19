test/integration/jobs-worker.int-spec.ts (23.916 s)
● relay -> BullMQ -> worker (real Redis) › retries with exponential backoff for 5 attempts in total, then dead-letters and announces it

    expect(received).toMatchObject(expected)

    - Expected  - 1
    + Received  + 1

      Object {
        "errorClass": "NETWORK",
    -   "executionAttemptCount": 5,
    +   "executionAttemptCount": 4,
        "publishAttemptCount": 1,
      }

      289 |
      290 |     expect(attempts).toEqual([1, 2, 3, 4, 5]);
    > 291 |     expect(await row(id)).toMatchObject({
          |                           ^
      292 |       executionAttemptCount: 5,
      293 |       publishAttemptCount: 1,
      294 |       errorClass: 'NETWORK',

      at Object.<anonymous> (test/integration/jobs-worker.int-spec.ts:291:27)

● relay -> BullMQ -> worker (real Redis) › recovers after Redis loses its jobs: the stale row is republished and processed

    waitFor timed out

      71 |     const value = await probe();
      72 |     if (value) return value;
    > 73 |     if (Date.now() > deadline) throw new Error('waitFor timed out');
         |                                      ^
      74 |     await sleep(25);
      75 |   }
      76 | }

      at waitFor (test/helpers/jobs.ts:73:38)
      at Object.<anonymous> (test/integration/jobs-worker.int-spec.ts:374:5)

Test Suites: 1 failed, 23 passed, 24 total
Tests: 2 failed, 766 passed, 768 total
Snapshots: 0 total
Time: 972.101 s
Ran all test suites.
