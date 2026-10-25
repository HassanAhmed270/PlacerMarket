const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_KEY = /^([a-z0-9-]+)-([a-f0-9]{12})$/i;

function listingUrlKey(listing) {
  return `${listing.slug}-${listing.short_id}`;
}

function canonicalListingUrl(listing, baseUrl = process.env.PUBLIC_BASE_URL || '') {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/listing/${listingUrlKey(listing)}`;
}

function parseListingUrlKey(value) {
  if (typeof value !== 'string') return null;
  if (UUID.test(value)) return { listingId: value };
  const match = URL_KEY.exec(value);
  if (!match) return null;
  return { shortId: match[2].toLowerCase(), requestedSlug: match[1] };
}

module.exports = { listingUrlKey, canonicalListingUrl, parseListingUrlKey };
