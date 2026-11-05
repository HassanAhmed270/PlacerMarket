const {
  adminHandoverRequest,
  buyerCancelRequest,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  db,
  escrowPayments,
  pickupTime,
  restoreHandoverTestEnvironment,
  setDeadlinePast,
  validHandoverBody,
} = require('./delivery-handover.helpers');

const RACE_REPETITIONS = 20;
let harness;
let scenarios;

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(() => {
  scenarios = [];
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  for (const scenario of scenarios) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-72 handover race serialization', () => {
  test('FR-33a, FR-72: handover and buyer cancellation have exactly one winner in 20 PostgreSQL races', async () => {
    for (let index = 0; index < RACE_REPETITIONS; index += 1) {
      const scenario = await createScenario(harness);
      scenarios.push(scenario);
      const body = await validHandoverBody(scenario);
      const [handover, cancellation] = await Promise.all([
        adminHandoverRequest(harness, scenario, body),
        buyerCancelRequest(scenario),
      ]);
      const handoverWon = handover.statusCode === 200;
      const cancellationWon = cancellation.statusCode === 200;
      expect(Number(handoverWon) + Number(cancellationWon)).toBe(1);
      expect(handover.statusCode).toBe(handoverWon ? 200 : 409);
      expect(cancellation.statusCode).toBe(cancellationWon ? 200 : 409);

      const { rows: refundRows } = await db.query(
        `SELECT count(*)::int AS count
         FROM refunds WHERE order_id = $1 AND trigger = 'system_cancel'`,
        [scenario.orderId]
      );
      expect(refundRows[0].count).toBe(cancellationWon ? 1 : 0);
      if (cancellationWon) {
        const { rows: stateRows } = await db.query(
          `SELECT order_row.status, reservation.status AS reservation_status
           FROM orders order_row
           JOIN reservations reservation ON reservation.id = order_row.reservation_id
           WHERE order_row.id = $1`,
          [scenario.orderId]
        );
        expect(stateRows[0]).toEqual({
          status: 'cancelled',
          reservation_status: 'released',
        });
      } else {
        const { rows: stateRows } = await db.query(
          'SELECT status FROM orders WHERE id = $1',
          [scenario.orderId]
        );
        expect(stateRows[0].status).toBe('handed_to_delivery');
      }
    }
  });

  test('FR-72: handover and the timeout refund have exactly one winner in 20 PostgreSQL races', async () => {
    for (let index = 0; index < RACE_REPETITIONS; index += 1) {
      const scenario = await createScenario(harness);
      scenarios.push(scenario);
      await setDeadlinePast(scenario);
      const body = await validHandoverBody(scenario, {
        courierPickupAt: await pickupTime(scenario, "handover_deadline_at - INTERVAL '1 minute'"),
      });
      const [handover, timeout] = await Promise.allSettled([
        adminHandoverRequest(harness, scenario, body),
        escrowPayments.refundUnhandedOverOrder({ orderId: scenario.orderId }),
      ]);
      expect(handover.status).toBe('fulfilled');
      expect(timeout.status).toBe('fulfilled');
      const timedOut = timeout.value.outcome === 'refunded';
      expect(['refunded', 'not_due']).toContain(timeout.value.outcome);
      expect(handover.value.statusCode).toBe(timedOut ? 409 : 200);

      const { rows: stateRows } = await db.query(
        `SELECT order_row.status,
                count(DISTINCT refund.id)::int AS timeout_refunds,
                count(DISTINCT exception.id)::int AS exceptions
         FROM orders order_row
         LEFT JOIN refunds refund ON refund.order_id = order_row.id
           AND refund.trigger = 'system_handover_timeout'
         LEFT JOIN order_exceptions exception ON exception.order_id = order_row.id
           AND exception.kind = 'late_handover_after_auto_cancel'
         WHERE order_row.id = $1
         GROUP BY order_row.status`,
        [scenario.orderId]
      );
      expect(stateRows[0]).toMatchObject({
        status: timedOut ? 'cancelled' : 'handed_to_delivery',
        timeout_refunds: timedOut ? 1 : 0,
        exceptions: timedOut ? 1 : 0,
      });
    }
  });
});
