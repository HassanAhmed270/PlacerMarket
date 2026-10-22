const { randomBytes } = require('node:crypto');

const apiBase = (process.env.DEMO_API_BASE_URL || 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const adminEmail = process.env.DEMO_ADMIN_EMAIL;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const adminTotpSecret = process.env.DEMO_ADMIN_TOTP_SECRET;

function ensureDemoOnly() {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_FAKES !== '1') throw new Error('demo:smoke requires non-production DEV_FAKES=1.');
  if (!adminEmail || !adminPassword || !adminTotpSecret) throw new Error('Run demo:seed and load backend/.demo.env before demo:smoke.');
}

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${apiBase}/${path.replace(/^\/+/, '')}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result = null;
  try { result = await response.json(); } catch { /* Empty response. */ }
  if (!response.ok) throw new Error(`${method} /${path} failed (${response.status}): ${result?.error || 'request rejected'}`);
  return result;
}

async function waitForCode(email, afterTime) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const messages = await call('dev/outbox?limit=100', { method: 'GET' });
    const match = messages.toReversed().find((message) => message.to === email && Date.parse(message.receivedAt) >= afterTime && message.subject.includes('verification code'));
    const code = match?.text.match(/verification code is (\d{6})/i)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the dev email outbox; confirm the worker is running with DEV_FAKES=1.');
}

function totpCode(secret) {
  return require('../src/lib/totp').generateTotpCode(secret);
}

async function waitForNewTotpStep() {
  const remaining = 30000 - (Date.now() % 30000) + 250;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function main() {
  ensureDemoOnly();
  await call('dev/outbox', { method: 'DELETE' });
  const cityList = await call('users/cities');
  const city = cityList.find((item) => item.name === 'Lahore Demo');
  if (!city) throw new Error('Demo city missing. Run demo:seed against the same database as the server.');
  const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const sellerEmail = `demo-seller-${suffix}@example.test`;
  const sellerPassword = `Demo-Seller-${randomBytes(12).toString('base64url')}-A1!`;
  const phone = `+1888${Date.now().toString().slice(-9)}`;

  await call('users/register', { method: 'POST', body: {
    name: 'Demo Seller', phone, email: sellerEmail, password: sellerPassword, cityId: city.id,
  } });
  console.log('1. Registered a new buyer through the API with the seeded demo city.');

  let emailCode = await waitForCode(sellerEmail, Date.now() - 20000);
  const verified = await call('users/email/verification/confirm', { method: 'POST', body: { email: sellerEmail, code: emailCode } });
  emailCode = null;
  if (!verified?.message) throw new Error('Registration email verification did not complete.');
  console.log('2. Confirmed the registration email using the code delivered to the development outbox.');

  const resendMs = Number(process.env.EMAIL_CODE_RESEND_SECONDS || 1) * 1000 + 150;
  await new Promise((resolve) => setTimeout(resolve, resendMs));
  const loginStartedAt = Date.now();
  const login = await call('users/login', { method: 'POST', body: { email: sellerEmail, password: sellerPassword } });
  if (!login?.loginAttemptId || login.factor !== 'email') throw new Error('Buyer login did not return the expected email-factor challenge.');
  const loginCode = await waitForCode(sellerEmail, loginStartedAt);
  const sellerSession = await call('users/login/verify-email-code', { method: 'POST', body: {
    email: sellerEmail, loginAttemptId: login.loginAttemptId, code: loginCode,
  } });
  if (!sellerSession?.accessToken) throw new Error('Buyer email-factor login did not issue a session.');
  console.log('3. Completed email-factor login using the second code from the development outbox.');

  await call('users/seller-applications', { method: 'POST', token: sellerSession.accessToken, body: {
    reasonForSelling: 'Local Phase 1 demonstration seller.', whatWillSell: 'Demo formal wear.',
  } });
  console.log('4. Submitted the seller application through the API.');

  await waitForNewTotpStep();
  const adminSession = await call('users/login/totp', { method: 'POST', body: {
    email: adminEmail, password: adminPassword, code: totpCode(adminTotpSecret),
  } });
  const adminToken = adminSession.accessToken;
  if (!adminToken) throw new Error('Demo Admin authenticator login did not issue a session.');
  const applications = await call('admin/seller-applications', { token: adminToken });
  const application = applications.find((item) => item.user_id && item.reason_for_selling === 'Local Phase 1 demonstration seller.');
  if (!application) throw new Error('New seller application was not present in the Admin queue.');
  await call(`admin/seller-applications/${application.id}/review`, { method: 'POST', token: adminToken, body: { decision: 'approved' } });
  console.log('5. Demo Admin signed in with TOTP and approved the seller application.');

  const sellerLoginStartedAt = Date.now();
  const sellerLogin = await call('users/login', { method: 'POST', body: { email: sellerEmail, password: sellerPassword } });
  if (!sellerLogin?.loginAttemptId || sellerLogin.factor !== 'email') throw new Error('Approved seller login did not return the expected email-factor challenge.');
  const sellerLoginCode = await waitForCode(sellerEmail, sellerLoginStartedAt);
  const approvedSellerSession = await call('users/login/verify-email-code', { method: 'POST', body: {
    email: sellerEmail, loginAttemptId: sellerLogin.loginAttemptId, code: sellerLoginCode,
  } });
  if (!approvedSellerSession?.accessToken) throw new Error('Approved seller email-factor login did not issue an enrollment session.');
  console.log('6. Approved seller signed in again with password and an email code from the development outbox.');

  const setup = await call('users/me/authenticator/enroll', { method: 'POST', token: approvedSellerSession.accessToken, body: {} });
  const enrollment = await call('users/me/authenticator/confirm', { method: 'POST', token: approvedSellerSession.accessToken, body: { code: totpCode(setup.secret) } });
  if (enrollment.backupCodes?.length !== 10) throw new Error('Seller enrollment did not issue ten backup codes.');
  console.log('7. Seller enrolled an authenticator; ten single-use backup codes were returned (codes omitted from transcript).');

  await waitForNewTotpStep();
  const grant = await call('users/auth/step-up', { method: 'POST', token: approvedSellerSession.accessToken, body: {
    action: 'payout.update', code: totpCode(setup.secret),
  } });
  const payout = await call('users/me/payout-method', { method: 'PATCH', token: approvedSellerSession.accessToken, body: {
    method: 'bank', bankName: 'Demo Bank', accountTitle: 'Demo Seller', iban: 'PK36SCBL0000001123456702', stepUpGrant: grant.grant,
  } });
  if (payout.last4 !== '6702') throw new Error('Payout update did not return the expected masked last four digits.');
  console.log('8. Seller completed authenticator step-up and saved encrypted bank details (API returned last four only).');

  const users = require('../src/modules/users.service');
  let blockedBeforeIdentity = false;
  try { await users.assertPayoutAllowed(application.user_id); }
  catch (error) { blockedBeforeIdentity = error.name === 'ForbiddenError'; }
  if (!blockedBeforeIdentity) throw new Error('Payout guard should refuse before manual identity verification.');
  console.log('9. Payout guard refused disbursement before identity verification.');

  await call(`admin/sellers/${application.user_id}/identity-verification`, { method: 'POST', token: adminToken, body: {
    note: 'Demo-only manual identity check completed.',
  } });
  const adminPayouts = await call('admin/payouts', { token: adminToken });
  const payoutRow = adminPayouts.find((item) => item.sellerId === application.user_id);
  if (!payoutRow?.idVerified || !payoutRow.changedRecently || payoutRow.last4 !== '6702') {
    throw new Error('Admin payout view did not expose expected masked identity/change flags.');
  }
  await users.assertPayoutAllowed(application.user_id);
  console.log('10. Admin payout view shows changedRecently=true, idVerified=true, and masked last4=6702.');
  console.log('11. Payout guard allows the verified seller; manual ID verification is a development demonstration only.');
  console.log(`Demo seller: ${sellerEmail}. Demo Admin credentials remain in backend/.demo.env; secrets and codes were omitted.`);
}

main().catch((error) => {
  console.error(`Demo smoke failed: ${error.message}`);
  process.exitCode = 1;
});
