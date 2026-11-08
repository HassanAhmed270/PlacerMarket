const db = require('../db.service');
const { validatePaymentsAdminCount } = require('../config');

async function assertPaymentsAdminGate(env = process.env, query = db.query) {
  if (env.NODE_ENV !== 'production' || env.PAYMENTS_ENABLED !== '1') {
    validatePaymentsAdminCount(env, undefined);
    return;
  }

  const { rows } = await query(
    `SELECT COUNT(DISTINCT u.id)::integer AS enrolled_admin_count
     FROM users u
     JOIN staff_totp_credentials c ON c.user_id = u.id AND c.enabled_at IS NOT NULL
     WHERE u.role = 'admin' AND u.is_suspended = false`
  );
  validatePaymentsAdminCount(env, Number(rows[0]?.enrolled_admin_count));
}

module.exports = { assertPaymentsAdminGate };
