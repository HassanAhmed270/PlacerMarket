/**
 * Owns append-only money audit records shared by money and identity workflows.
 * Tables owned: money_audit_events
 */

/** FR-69: write money and identity audit events in the caller's transaction. */
async function recordMoneyAuditEvent(client, {
  actorId = null,
  action,
  orderId = null,
  paymentId = null,
  refundId = null,
  requestedBy = null,
  approvedBy = null,
  reason = null,
  requestId = null,
  metadata = {},
}) {
  return client.query(
    `INSERT INTO money_audit_events
       (actor_id, action, order_id, payment_id, refund_id, requested_by, approved_by, reason, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      actorId,
      action,
      orderId,
      paymentId,
      refundId,
      requestedBy,
      approvedBy,
      reason,
      requestId,
      JSON.stringify(metadata),
    ]
  );
}

/** FR-45, FR-69: write a deduplicated money audit event in the caller's transaction. */
async function recordMoneyAuditEventOnce(client, {
  actorId = null,
  action,
  orderId = null,
  reason = null,
  metadata = {},
  uniqueMetadataKey,
  uniqueMetadataValue,
}) {
  const { rows } = await client.query(
    `INSERT INTO money_audit_events (actor_id, action, order_id, reason, metadata)
     SELECT $1, $2, $3, $4, $5::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM money_audit_events
       WHERE order_id = $3 AND action = $2 AND metadata->>$6 = $7
     )
     RETURNING id`,
    [
      actorId,
      action,
      orderId,
      reason,
      JSON.stringify(metadata),
      uniqueMetadataKey,
      uniqueMetadataValue,
    ]
  );
  return rows.length > 0;
}

module.exports = { recordMoneyAuditEvent, recordMoneyAuditEventOnce };
