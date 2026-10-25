const { randomBytes } = require('node:crypto');
const queue = require('../src/lib/queue');

const apiBase = (process.env.DEMO_API_BASE_URL || 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const adminEmail = process.env.DEMO_ADMIN_EMAIL;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const adminTotpSecret = process.env.DEMO_ADMIN_TOTP_SECRET;

function ensureDemoOnly() {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_FAKES !== '1') throw new Error('demo:smoke requires non-production DEV_FAKES=1.');
  if (!adminEmail || !adminPassword || !adminTotpSecret) throw new Error('Run demo:seed and load backend/.demo.env before demo:smoke.');
  if (!process.env.DEMO_DATABASE_URL || !process.env.DATABASE_URL) {
    throw new Error('demo:smoke requires both DEMO_DATABASE_URL and DATABASE_URL to be configured.');
  }
  const demoDatabase = new URL(process.env.DEMO_DATABASE_URL);
  const applicationDatabase = new URL(process.env.DATABASE_URL);
  const databaseName = decodeURIComponent(demoDatabase.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(demoDatabase.protocol)
      || !['localhost', '127.0.0.1', '::1'].includes(demoDatabase.hostname)
      || !/(?:demo|dev|local)/i.test(databaseName) || /testing_only|test/i.test(databaseName)
      || demoDatabase.host !== applicationDatabase.host
      || demoDatabase.pathname !== applicationDatabase.pathname) {
    throw new Error('demo:smoke only accepts the matching localhost development/demo database (never testing_only).');
  }
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

async function waitForSearchRow(listingId, { askingPrice, timeoutMs = 30000 } = {}) {
  const db = require('../src/db.service');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT search.listing_id, search.asking_price
         FROM listing_search search
         JOIN listings listing ON listing.id = search.listing_id
        WHERE search.listing_id = $1
          AND search.search_version = listing.search_version
          AND ($2::numeric IS NULL OR search.asking_price = $2::numeric)`,
      [listingId, askingPrice ?? null]
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The worker did not sync the current listing version into the search index.');
}

async function waitForRemovedFromSearch(listingId, timeoutMs = 30000) {
  const db = require('../src/db.service');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query('SELECT listing_id FROM listing_search WHERE listing_id = $1', [listingId]);
    if (!rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The listing stayed in search after being marked sold.');
}

async function waitForListingSnapshot(pathname, { includes = [], timeoutMs = 30000 } = {}) {
  const db = require('../src/db.service');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query('SELECT html, path FROM page_snapshots WHERE path = $1', [pathname]);
    if (rows[0] && includes.every((value) => rows[0].html.includes(value))) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No snapshot for ${pathname} was generated.`);
}

async function main() {
  ensureDemoOnly();
  await queue.startProducer();
  await call('dev/outbox', { method: 'DELETE' });
  const cityList = await call('users/cities');
  const city = cityList.find((item) => item.name === 'Lahore Demo');
  if (!city) throw new Error('Demo city missing. Run demo:seed against the same database as the server.');
  const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const searchTerm = `demo${randomBytes(5).toString('hex')}`;
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
  const colorResult = await db.query(
    "SELECT id, value FROM managed_catalog_values WHERE attribute_type = 'color' AND status = 'approved' ORDER BY lower(value) LIMIT 1"
  );
  if (!colorResult.rows[0]) throw new Error('No approved color was available for search-filter validation.');
  const color = colorResult.rows[0];
  await db.query(
    "INSERT INTO search_synonyms (source_term, target_term, created_by, updated_by) VALUES ($1, $2, $3, $3) ON CONFLICT (normalized_source_term, normalized_target_term) DO NOTHING",
    ['shalwar', 'kameez', application.user_id]
  );
  const listing = await call('listings', { method: 'POST', token: approvedSellerSession.accessToken, body: {
    title: `Demo ${searchTerm} kameez`, mainCategoryId: catalog[0].category_id, subCategoryId: catalog[0].sub_category_id,
    condition: 'brand_new', askingPrice: 1000, description: 'Local moderated listing demonstration.',
    colorId: color.id,
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
  const publicBefore = await call(`discovery/listings/${listing.id}`);
  const publicJson = JSON.stringify(publicBefore);
  if (publicBefore.title !== `Demo ${searchTerm} kameez` || !publicJson.includes('/api/media/images/') || /original_key|thumbnail_key|medium_key|large_key|content_hash|private-media/.test(publicJson)) {
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
  const approvedHighPrice = Number(revision.proposed_asking_price);
  const unchanged = await call(`discovery/listings/${listing.id}`);
  if (Number(unchanged.asking_price) !== 1000) throw new Error('Public listing changed before revision approval.');
  let thresholdRefused = false;
  try { await call(`listings/revisions/${revision.id}/approve`, { method: 'POST', token: adminToken }); }
  catch (error) { thresholdRefused = error.message.includes('(403)'); }
  if (!thresholdRefused) throw new Error('Above-threshold approval was not refused for an unverified email.');
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [application.user_id]);
  const beforeVersion = Number((await db.query('SELECT content_version FROM listings WHERE id = $1', [listing.id])).rows[0].content_version);
  await call(`listings/revisions/${revision.id}/approve`, { method: 'POST', token: adminToken });
  const publicAfter = await call(`discovery/listings/${listing.id}`);
  const afterVersion = Number((await db.query('SELECT content_version FROM listings WHERE id = $1', [listing.id])).rows[0].content_version);
  if (Number(publicAfter.asking_price) !== approvedHighPrice || afterVersion !== beforeVersion + 1) throw new Error('Approved revision did not publish and increment content_version exactly once.');
  console.log('14. Concurrent price edit yielded exactly one pending revision; public detail stayed unchanged. Unverified above-threshold approval was refused. After email verification and moderator approval, public price updated and content_version incremented once.');

  const listingSearch = require('../src/modules/listingSearch.service');
  const pageSnapshots = require('../src/modules/pageSnapshots.service');
  const foundInSearch = await waitForSearchRow(listing.id);
  if (!foundInSearch) throw new Error('The listing did not finish replaying into search.');

  const keywordResults = await call(`discovery/search?q=${encodeURIComponent(searchTerm)}&limit=10`);
  if (!keywordResults.items.some((item) => item.id === listing.id)) throw new Error('The buyer could not find the listing by keyword.');
  const colorResults = await call(`discovery/search?q=${encodeURIComponent(searchTerm)}&colorId=${encodeURIComponent(color.id)}&limit=10`);
  if (!colorResults.items.some((item) => item.id === listing.id)) throw new Error('The buyer could not find the listing by the approved color filter.');
  const synonymResults = await call(`discovery/search?q=${encodeURIComponent(`shalwar ${searchTerm}`)}&limit=10`);
  if (!synonymResults.items.some((item) => item.id === listing.id)) throw new Error('The buyer could not find the listing by the Roman Urdu synonym.');
  console.log('15. The worker synced the listing into search; a buyer found it by keyword, by filters using an approved color, and by the Roman Urdu synonym.');

  const buyerEmail = `demo-buyer-${Date.now()}@example.test`;
  const buyerPassword = `Demo-Buyer-${randomBytes(12).toString('base64url')}-A1!`;
  const buyerPhone = `+1888${Date.now().toString().slice(-9)}`;
  await call('users/register', { method: 'POST', body: {
    name: 'Demo Buyer', phone: buyerPhone, email: buyerEmail, password: buyerPassword, cityId: city.id,
  } });
  const buyerCode = await waitForCode(buyerEmail, Date.now() - 20000);
  await call('users/email/verification/confirm', { method: 'POST', body: { email: buyerEmail, code: buyerCode } });
  await new Promise((resolve) => setTimeout(resolve, resendMs));
  const buyerLoginStartedAt = Date.now();
  const buyerLogin = await call('users/login', { method: 'POST', body: { email: buyerEmail, password: buyerPassword } });
  const buyerLoginCode = await waitForCode(buyerEmail, buyerLoginStartedAt);
  const buyerSession = await call('users/login/verify-email-code', { method: 'POST', body: {
    email: buyerEmail, loginAttemptId: buyerLogin.loginAttemptId, code: buyerLoginCode,
  } });
  if (!buyerSession?.accessToken) throw new Error('Buyer account login did not issue a session.');
  await call(`discovery/listings/${listing.id}/favorite`, { method: 'POST', token: buyerSession.accessToken });
  const favorites = await call('discovery/favorites', { token: buyerSession.accessToken });
  if (!favorites.items?.some((item) => item.id === listing.id)) throw new Error('The favorited listing was not present in the buyer favorites list.');
  console.log('16. The buyer favorited the listing.');

  const conversation = await call('negotiation/conversations', { method: 'POST', token: buyerSession.accessToken, body: { listingId: listing.id } });
  let phoneRejected = false;
  try {
    await call(`negotiation/conversations/${conversation.id}/messages`, { method: 'POST', token: buyerSession.accessToken, body: { body: 'Please call +18881234567 by 6pm.' } });
  } catch (error) {
    phoneRejected = /phone|email|link/i.test(String(error.message));
  }
  if (!phoneRejected) throw new Error('A phone-number message was not blocked.');
  const priceMessage = await call(`negotiation/conversations/${conversation.id}/messages`, { method: 'POST', token: buyerSession.accessToken, body: { body: 'Could you share your price in PKR 85,000?' } });
  if (!priceMessage?.body || !/PKR 85,000/i.test(String(priceMessage.body))) throw new Error('A price-only message was incorrectly rejected.');

  const strangerEmail = `demo-stranger-${Date.now()}@example.test`;
  const strangerPassword = `Demo-Stranger-${randomBytes(12).toString('base64url')}-A1!`;
  const strangerPhone = `+1888${Date.now().toString().slice(-9)}`;
  await call('users/register', { method: 'POST', body: {
    name: 'Demo Stranger', phone: strangerPhone, email: strangerEmail, password: strangerPassword, cityId: city.id,
  } });
  const strangerCode = await waitForCode(strangerEmail, Date.now() - 20000);
  await call('users/email/verification/confirm', { method: 'POST', body: { email: strangerEmail, code: strangerCode } });
  await new Promise((resolve) => setTimeout(resolve, resendMs));
  const strangerLoginStartedAt = Date.now();
  const strangerLogin = await call('users/login', { method: 'POST', body: { email: strangerEmail, password: strangerPassword } });
  const strangerLoginCode = await waitForCode(strangerEmail, strangerLoginStartedAt);
  const strangerSession = await call('users/login/verify-email-code', { method: 'POST', body: {
    email: strangerEmail, loginAttemptId: strangerLogin.loginAttemptId, code: strangerLoginCode,
  } });
  let strangerReadRejected = false;
  try {
    await call(`negotiation/conversations/${conversation.id}/messages`, { method: 'GET', token: strangerSession.accessToken });
  } catch (error) {
    strangerReadRejected = /404|not found|forbidden/i.test(String(error.message));
  }
  if (!strangerReadRejected) throw new Error('A stranger was able to read a private conversation.');
  console.log('17. Messaging blocked the phone-number attempt and accepted the price-only note; a stranger could not read the conversation.');

  const immediatePrice = Math.round(approvedHighPrice * 0.8 * 100) / 100;
  await call(`listings/${listing.id}/revisions`, { method: 'POST', token: approvedSellerSession.accessToken, body: { askingPrice: immediatePrice } });
  const liveImmediately = await call(`discovery/listings/${listing.id}`);
  if (Number(liveImmediately.asking_price) !== immediatePrice) throw new Error('The 20% price drop did not go live immediately.');
  await waitForSearchRow(listing.id, { askingPrice: immediatePrice });
  const liveSearchAfter20 = await call(
    `discovery/search?colorId=${encodeURIComponent(color.id)}&minPrice=${encodeURIComponent(immediatePrice)}&maxPrice=${encodeURIComponent(immediatePrice)}&limit=10`
  );
  if (!liveSearchAfter20.items.some((item) => item.id === listing.id && Number(item.asking_price) === immediatePrice)) {
    throw new Error('The 20% price drop did not appear in search.');
  }
  console.log('18. The seller lowered the price by 20%; the new price was immediately live in search and detail.');

  const pendingPrice = Math.round(immediatePrice * 0.6 * 100) / 100;
  const pending40 = await call(`listings/${listing.id}/revisions`, { method: 'POST', token: approvedSellerSession.accessToken, body: { askingPrice: pendingPrice } });
  if (!pending40 || !['pending_review', 'pending'].includes(pending40.status)) {
    throw new Error('The 40% price drop did not create a pending revision.');
  }
  const liveAfter40 = await call(`discovery/listings/${listing.id}`);
  if (Number(liveAfter40.asking_price) !== immediatePrice) throw new Error('The pending 40% revision should not have changed the live listing.');
  console.log('19. The seller created a 40% price reduction that became a pending revision; the live listing remained unchanged while it awaited review.');

  const canonicalPath = `/listing/${liveAfter40.canonicalKey}`;
  const snapshot = await waitForListingSnapshot(canonicalPath, { includes: [liveAfter40.title, '@context', 'canonical'] });
  if (!snapshot.html.includes(liveAfter40.title) || !snapshot.html.includes('@context') || !snapshot.html.includes('canonical')) {
    throw new Error('The listing snapshot did not include the required title, JSON-LD, or canonical data.');
  }
  const sitemapResponse = await fetch('http://127.0.0.1:3000/sitemap.xml', { method: 'GET', headers: { Accept: 'application/xml,text/xml' } });
  const sitemapHtml = await sitemapResponse.text();
  if (!sitemapResponse.ok || (!sitemapHtml.includes(canonicalPath) && !sitemapHtml.includes('http://127.0.0.1:3000' + canonicalPath))) {
    throw new Error('The sitemap did not list the listing.');
  }
  console.log('20. The listing snapshot included the title, JSON-LD and canonical URL, and the sitemap listed it.');

  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      "UPDATE listings SET status = 'sold', search_version = search_version + 1, updated_at = now() WHERE id = $1 RETURNING search_version",
      [listing.id]
    );
    await listingSearch.enqueueListingSearchSync(client, listing.id, rows[0].search_version);
    await pageSnapshots.enqueueListingSnapshotSync(client, listing.id, rows[0].search_version);
  });
  await waitForRemovedFromSearch(listing.id);
  const soldDetail = await call(`discovery/listings/${listing.id}`);
  if (!soldDetail.sold || !soldDetail.similarItems || soldDetail.similarItems.length === 0) {
    throw new Error('The sold listing did not leave search and did not render Sold with similar items.');
  }
  const soldSearch = await call(
    `discovery/search?q=${encodeURIComponent(searchTerm)}&colorId=${encodeURIComponent(color.id)}&minPrice=${encodeURIComponent(immediatePrice)}&maxPrice=${encodeURIComponent(immediatePrice)}&limit=10`
  );
  if (soldSearch.items.some((item) => item.id === listing.id)) throw new Error('The sold listing still appeared in search results.');
  const soldSnapshot = await waitForListingSnapshot(canonicalPath, { includes: ['<p>Sold</p>', 'Similar items'] });
  if (!/<section aria-labelledby="similar-listings"><h2 id="similar-listings">Similar items<\/h2><ul><li>/.test(soldSnapshot.html)) {
    throw new Error('The sold listing snapshot did not render at least one similar item.');
  }
  console.log('21. When the listing was marked sold, it left search and the detail page showed Sold with similar items.');

  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      "UPDATE listings SET status = 'removed', search_version = search_version + 1, updated_at = now() WHERE id = $1 RETURNING search_version",
      [listing.id]
    );
    await listingSearch.enqueueListingSearchSync(client, listing.id, rows[0].search_version);
    await pageSnapshots.enqueueListingSnapshotSync(client, listing.id, rows[0].search_version);
  });
  await waitForRemovedFromSearch(listing.id);
  let removedStatus = 0;
  try {
    await call(`discovery/listings/${listing.id}`);
  } catch (error) {
    removedStatus = Number(String(error.message).match(/\((\d+)\)/)?.[1] || 0);
  }
  if (removedStatus !== 410) throw new Error('A removed listing did not return a 410 response.');
  console.log('22. A removed listing returned HTTP 410.');

  const checkoutUrl = `http://127.0.0.1:5173/checkout/soon?listing=${encodeURIComponent(`/listing/${liveAfter40.canonicalKey}`)}`;
  const checkoutPage = await fetch(checkoutUrl, { method: 'GET', headers: { Accept: 'text/html' } });
  const checkoutHtml = await checkoutPage.text();
  const checkoutModule = await fetch('http://127.0.0.1:5173/src/App.jsx');
  const checkoutSource = await checkoutModule.text();
  if (!checkoutPage.ok || !checkoutHtml.includes('id="root"') || !checkoutModule.ok || !/Checkout opens soon/i.test(checkoutSource)) {
    throw new Error('The Buy flow route or its checkout-open-soon screen module was unavailable.');
  }
  console.log('23. The Buy flow reached the checkout-open-soon route and the screen module was served.');

  const apiCache = await fetch(`http://127.0.0.1:3000/api/discovery/listings/${listing.id}`, { method: 'GET', headers: { Accept: 'application/json' } });
  const pageCache = await fetch(`http://127.0.0.1:3000${canonicalPath}`, { method: 'GET', headers: { Accept: 'text/html' } });
  if (!apiCache.headers.get('cache-control')?.includes('max-age=10')) throw new Error('API cache policy did not hold.');
  if (!pageCache.headers.get('cache-control')?.includes('stale-while-revalidate=60')) throw new Error('Public-page cache policy did not hold.');
  console.log('24. The route cache policy held for the API and browser-facing public routes.');

  console.log(`Demo seller: ${sellerEmail}. Demo Admin credentials remain in backend/.demo.env; secrets and codes were omitted.`);
}

main().catch((error) => {
  console.error(`Demo smoke failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await queue.stopProducer();
  } catch {}
});
