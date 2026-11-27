const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const metricsMiddleware = require('../../src/middleware/metricsMiddleware');
const { snapshotMetrics, recordRequestStatus, recordQueueFailure } = require('../../src/lib/metrics');

describe('FR-79h: process metrics', () => {
  test('FR-79h: metrics counts requests and status classes', async () => {
    recordRequestStatus(200);
    recordRequestStatus(404);
    recordRequestStatus(503);
    const app = express();
    app.use(metricsMiddleware);
    app.get('/test', (_req, res) => res.status(204).end());
    await request(app).get('/test');
    const snapshot = snapshotMetrics();
    expect(snapshot.scope).toBe('this process since start');
    expect(snapshot.totalRequests).toBeGreaterThan(0);
    expect(snapshot.statusClasses['2xx']).toBeGreaterThan(0);
    expect(snapshot.statusClasses['4xx']).toBeGreaterThan(0);
    expect(snapshot.statusClasses['5xx']).toBeGreaterThan(0);
  });

  test('FR-79h: queue failure increments the failure counter', () => {
    const before = snapshotMetrics().queueFailures;
    recordQueueFailure();
    expect(snapshotMetrics().queueFailures).toBe(before + 1);
  });

  test('FR-79h: metrics endpoint shape is no-store and Admin-only', () => {
    const snapshot = snapshotMetrics();
    expect(snapshot.scope).toBe('this process since start');
    const source = fs.readFileSync(path.join(__dirname, '../../src/routes/admin.routes.js'), 'utf8');
    expect(source).toContain("router.get(\n  '/metrics'");
    expect(source).toContain("requirePermission('operations.view')");
    expect(source).toContain('noStoreOrderResponses');
  });
});
