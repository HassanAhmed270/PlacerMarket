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

async function upload(path, bytes, token) {
  const response = await fetch(`${apiBase}/${path.replace(/^\/+/, '')}`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` }, body: bytes,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`POST /${path} failed (${response.status}): ${result?.error || 'request rejected'}`);
  return result;
}

async function waitForImages(imageIds) {
  const db = require('../src/db.service');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { rows } = await db.query('SELECT id, processing_state FROM listing_images WHERE id = ANY($1::uuid[])', [imageIds]);
    if (rows.length === imageIds.length && rows.every((row) => row.processing_state === 'ready')) return;
    if (rows.some((row) => row.processing_state === 'failed')) throw new Error('A demo listing image failed processing.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for worker-produced image variants.');
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

  const db = require('../src/db.service');
  const sharp = require('sharp');
  const { rows: catalog } = await db.query(
    `SELECT c.id AS category_id, s.id AS sub_category_id, m.id AS field_id
     FROM main_categories c JOIN sub_categories s ON s.main_category_id = c.id
     JOIN measurement_field_defs m ON m.sub_category_id = s.id
     WHERE c.name = 'Women Demo' AND s.name = 'Formal Demo' AND m.field_name = 'chest demo'`
  );
  if (!catalog[0]) throw new Error('Demo listing catalog is missing; rerun demo:seed on this development database.');
  const listing = await call('listings', { method: 'POST', token: approvedSellerSession.accessToken, body: {
    title: 'Demo listing before review', mainCategoryId: catalog[0].category_id, subCategoryId: catalog[0].sub_category_id,
    condition: 'brand_new', askingPrice: 1000, description: 'Local moderated listing demonstration.',
    measurements: [{ fieldDefId: catalog[0].field_id, value: 40 }],
  } });
  const slots = ['front', 'back', 'other'];
  const images = [];
  for (const [index, slot] of slots.entries()) {
    const png = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 40 + index * 30, g: 90, b: 160 } } }).png().toBuffer();
    images.push(await upload(`media/listings/${listing.id}/images?slot=${slot}`, png, approvedSellerSession.accessToken));
  }
  await waitForImages(images.map((image) => image.id));
  console.log('12. Seller created a listing and uploaded tiny generated PNGs to Front, Back, and Other; the worker produced variants.');
  await call(`listings/${listing.id}/submit`, { method: 'POST', token: approvedSellerSession.accessToken });
  for (const photo of images) await call(`listings/photos/${photo.id}/confirm`, { method: 'POST', token: adminToken });
  await call(`listings/${listing.id}/approve`, { method: 'POST', token: adminToken });
  const publicBefore = await call(`listings/${listing.id}`);
  const publicJson = JSON.stringify(publicBefore);
  if (publicBefore.title !== 'Demo listing before review' || !publicJson.includes('/api/media/images/') || /original_key|thumbnail_key|medium_key|large_key|content_hash|private-media/.test(publicJson)) {
    throw new Error('Public listing detail did not expose a safe processed variant URL.');
  }
  console.log('13. Moderator confirmed every required photo and approved the listing; public detail contains a processed variant URL and no private storage keys.');

  const { rows: threshold } = await db.query("SELECT value::numeric AS value FROM platform_settings WHERE key = 'high_value_threshold_pkr'");
  const highPrice = Number(threshold[0].value) + 1;
  await db.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [application.user_id]);
  const results = await Promise.allSettled([
    call(`listings/${listing.id}/revisions`, { method: 'POST', token: approvedSellerSession.accessToken, body: { askingPrice: highPrice } }),
    call(`listings/${listing.id}/revisions`, { method: 'POST', token: approvedSellerSession.accessToken, body: { askingPrice: highPrice + 1 } }),
  ]);
  const accepted = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  if (accepted.length !== 1 || refused.length !== 1 || !refused[0].reason.message.includes('(409)')) throw new Error('Concurrent revision submit did not yield exactly one pending revision.');
  const revision = accepted[0].value;
  const unchanged = await call(`listings/${listing.id}`);
  if (Number(unchanged.asking_price) !== 1000) throw new Error('Public listing changed before revision approval.');
  let thresholdRefused = false;
  try { await call(`listings/revisions/${revision.id}/approve`, { method: 'POST', token: adminToken }); }
  catch (error) { thresholdRefused = error.message.includes('(403)'); }
  if (!thresholdRefused) throw new Error('Above-threshold approval was not refused for an unverified email.');
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [application.user_id]);
  const beforeVersion = Number((await db.query('SELECT content_version FROM listings WHERE id = $1', [listing.id])).rows[0].content_version);
  await call(`listings/revisions/${revision.id}/approve`, { method: 'POST', token: adminToken });
  const publicAfter = await call(`listings/${listing.id}`);
  const afterVersion = Number((await db.query('SELECT content_version FROM listings WHERE id = $1', [listing.id])).rows[0].content_version);
  if (Number(publicAfter.asking_price) !== highPrice || afterVersion !== beforeVersion + 1) throw new Error('Approved revision did not publish and increment content_version exactly once.');
  console.log('14. Concurrent price edit yielded exactly one pending revision; public detail stayed unchanged. Unverified above-threshold approval was refused. After email verification and moderator approval, public price updated and content_version incremented once.');
  console.log(`Demo seller: ${sellerEmail}. Demo Admin credentials remain in backend/.demo.env; secrets and codes were omitted.`);
}

main().catch((error) => {
  console.error(`Demo smoke failed: ${error.message}`);
  process.exitCode = 1;
});
