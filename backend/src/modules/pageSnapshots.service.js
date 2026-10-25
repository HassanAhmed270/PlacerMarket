const db = require('../db.service');
const queue = require('../lib/queue');
const { canonicalListingUrl, parseListingUrlKey } = require('../lib/listingUrls');
const { generateSeoRecommendation } = require('../lib/listingSeo');

const SNAPSHOT_QUEUE = queue.QUEUES.PAGE_SNAPSHOTS;
const SEARCH_FILTER_KEYS = new Set([
  'q', 'query', 'sort', 'sort_by', 'price', 'minprice', 'maxprice', 'min_price', 'max_price',
  'condition', 'color', 'colorid', 'color_id', 'brand', 'brandid', 'brand_id',
  'fabric', 'fabricid', 'fabric_id',
]);
const CONDITION_SCHEMA = Object.freeze({
  brand_new: 'https://schema.org/NewCondition',
  pre_owned: 'https://schema.org/UsedCondition',
  custom_made: 'https://schema.org/NewCondition',
  replica: 'https://schema.org/NewCondition',
});
const PUBLIC_LISTING_QUERY = `
  SELECT l.id, l.slug, l.short_id, l.title, l.description, l.condition::text AS condition,
         l.asking_price, l.status::text AS status, l.seo_choice, l.seo_title, l.seo_description,
         l.color, l.fabric_material, l.brand,
         l.main_category_id, main.name AS main_category,
         l.sub_category_id, sub.name AS sub_category,
         seller.city_id, city.name AS city_name,
         cover.id AS image_id, cover.social_key,
         EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status IN ('delivered', 'held', 'completed')) AS completed_order
  FROM listings l
  JOIN main_categories main ON main.id = l.main_category_id
  JOIN sub_categories sub ON sub.id = l.sub_category_id
  JOIN users seller ON seller.id = l.seller_id
  LEFT JOIN cities city ON city.id = seller.city_id
  LEFT JOIN LATERAL (
    SELECT id, social_key FROM listing_images
    WHERE listing_id = l.id AND processing_state = 'ready' AND social_key IS NOT NULL
    ORDER BY display_order, id LIMIT 1
  ) cover ON TRUE`;

// FR-81a: encode all seller-controlled text before including it in public HTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// FR-82b: keep structured data safe to embed in an HTML script element.
function escapeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

// FR-82a: derive stable public taxonomy path segments from catalog labels.
function slugify(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
}

// FR-82a: map a main category to its canonical public path.
function mainCategoryPath(category) {
  return `/category/${slugify(category.name)}`;
}

// FR-82a: map a sub-category to its canonical public path.
function subCategoryPath(mainCategory, subCategory) {
  return `${mainCategoryPath(mainCategory)}/${slugify(subCategory.name)}`;
}

// FR-82a: map a category and seller city to its canonical public path.
function categoryCityPath(mainCategory, subCategory, city) {
  return `${subCategoryPath(mainCategory, subCategory)}/city/${slugify(city)}`;
}

// FR-82a: apply the indexability rules to canonical and filtered page requests.
function isNoindex({ pageType, status, pathname = '', searchParams = new URLSearchParams() }) {
  if (pageType === 'search' || pathname === '/search') return true;
  if (status === 'sold' || status === 'paused' || status === 'removed' || status === 'unpublished') return true;
  for (const key of searchParams.keys()) {
    if (SEARCH_FILTER_KEYS.has(key.toLowerCase()) || ['page', 'cursor', 'limit'].includes(key.toLowerCase())) return true;
  }
  return false;
}

// FR-82b: build shared title, description, canonical, crawler, and Open Graph tags.
function pageHead({ title, description, canonical, noindex = false, image, type = 'website' }) {
  const robots = noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow">';
  const imageTags = image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : '';
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${robots}<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="${escapeHtml(type)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">${imageTags}<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"></head>`;
}

// FR-81a: wrap rendered snapshot content with the SPA entry for every client.
function documentHtml({ head, body, jsonLd, pageType, spaEntry = '/src/main.jsx' }) {
  const structuredData = jsonLd
    ? `<script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>`
    : '';
  return `<!doctype html><html lang="en">${head}<body><div id="root" data-spa-page="${escapeHtml(pageType)}">${body}</div>${structuredData}<script type="module" src="${escapeHtml(spaEntry)}"></script></body></html>`;
}

// FR-81a: point generated HTML at the configured SPA bundle or public Vite entry.
function resolveSpaEntry(baseUrl) {
  if (process.env.PUBLIC_SPA_ENTRY_URL) return process.env.PUBLIC_SPA_ENTRY_URL;
  if (process.env.PUBLIC_BASE_URL) return `${baseUrl}/src/main.jsx`;
  return '/src/main.jsx';
}

// FR-82a: apply recommended or custom SEO titles with the replica guardrail.
function effectiveListingTitle(listing) {
  const title = listing.title || '';
  return listing.condition === 'replica' && !/\breplica\b/i.test(title) ? `Replica ${title}` : title;
}

// FR-82a: choose the seller's accepted metadata text or the structured recommendation.
function effectiveSeoTitle(listing) {
  const recommendation = generateSeoRecommendation({
    condition: listing.condition,
    subCategory: listing.sub_category,
    color: listing.color,
    fabricMaterial: listing.fabric_material,
    brand: listing.brand,
    city: listing.city_name,
  });
  const title = listing.seo_choice === 'custom' && listing.seo_title
    ? listing.seo_title
    : recommendation.title || effectiveListingTitle(listing);
  return listing.condition === 'replica' && !/\breplica\b/i.test(title) ? `Replica ${title}` : title;
}

// FR-82b: reference the existing immutable 1200x630 social image variant.
function imageUrl(listing, baseUrl) {
  if (!listing.image_id || !listing.social_key) return null;
  const hash = listing.social_key.split('/')[1];
  return `${baseUrl}/api/media/images/${encodeURIComponent(listing.image_id)}/social/${encodeURIComponent(hash)}.webp`;
}

// FR-82b: generate Product, Offer, and BreadcrumbList data without review ratings.
function buildListingJsonLd(listing, { canonical, mainPath, subPath, baseUrl = '' }) {
  const sold = listing.status === 'sold' || listing.completed_order;
  const unavailable = sold || listing.status !== 'published';
  const description = listing.seo_choice === 'custom' && listing.seo_description
    ? listing.seo_description
    : generateSeoRecommendation({
      condition: listing.condition,
      subCategory: listing.sub_category,
      color: listing.color,
      fabricMaterial: listing.fabric_material,
      brand: listing.brand,
      city: listing.city_name,
    }).description || listing.description || '';
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: effectiveListingTitle(listing),
    description,
    ...(listing.image_id && listing.social_key ? { image: imageUrl(listing, baseUrl) } : {}),
    ...(listing.brand ? { brand: { '@type': 'Brand', name: listing.brand } } : {}),
    ...(listing.color ? { color: listing.color } : {}),
    itemCondition: CONDITION_SCHEMA[listing.condition],
    offers: {
      '@type': 'Offer',
      url: canonical,
      price: String(listing.asking_price),
      priceCurrency: 'PKR',
      availability: unavailable
        ? 'https://schema.org/OutOfStock'
        : 'https://schema.org/InStock',
      itemCondition: CONDITION_SCHEMA[listing.condition],
    },
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
      { '@type': 'ListItem', position: 2, name: listing.main_category, item: `${baseUrl}${mainPath}` },
      { '@type': 'ListItem', position: 3, name: listing.sub_category, item: `${baseUrl}${subPath}` },
      { '@type': 'ListItem', position: 4, name: effectiveListingTitle(listing), item: canonical },
    ],
  };
  return [product, breadcrumb];
}

// FR-81a: choose the six newest published items within thirty percent of a sold price.
function similarListings(soldListing, publishedListings) {
  const price = Number(soldListing.asking_price);
  const boundary = price * 0.3;
  return publishedListings
    .filter((item) => item.status === 'published' && item.sub_category_id === soldListing.sub_category_id
      && Math.abs(Number(item.asking_price) - price) <= boundary)
    .slice(0, 6);
}

// FR-81a, FR-82b: render the public HTML snapshot for a listing.
function renderListingPage(listing, { baseUrl = process.env.PUBLIC_BASE_URL || '', spaEntry = resolveSpaEntry(baseUrl), similarItems = [] } = {}) {
  const canonical = canonicalListingUrl(listing, baseUrl);
  const mainPath = `/category/${slugify(listing.main_category)}`;
  const subPath = `${mainPath}/${slugify(listing.sub_category)}`;
  const status = listing.status === 'published' && listing.completed_order ? 'sold' : listing.status;
  const noindex = isNoindex({ pageType: 'listing', status });
  const title = effectiveSeoTitle(listing);
  const listingTitle = effectiveListingTitle(listing);
  const description = listing.seo_choice === 'custom' && listing.seo_description
    ? listing.seo_description
    : generateSeoRecommendation({
      condition: listing.condition,
      subCategory: listing.sub_category,
      color: listing.color,
      fabricMaterial: listing.fabric_material,
      brand: listing.brand,
      city: listing.city_name,
    }).description || listing.description || `${listing.condition.replace('_', ' ')} ${listing.sub_category}`;
  const price = Number(listing.asking_price).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  const sold = status === 'sold';
  const unavailable = status === 'paused';
  const removed = ['removed', 'unpublished'].includes(status);
  const similar = sold ? `<section aria-labelledby="similar-listings"><h2 id="similar-listings">Similar items</h2><ul>${similarItems.map((item) => `<li><a href="${escapeHtml(canonicalListingUrl(item, baseUrl))}">${escapeHtml(effectiveListingTitle(item))}</a><span> PKR ${escapeHtml(Number(item.asking_price).toLocaleString('en-PK', { maximumFractionDigits: 2 }))}</span></li>`).join('')}</ul></section>` : '';
  const body = `<main><nav aria-label="Breadcrumb"><a href="/">Home</a> / <a href="${escapeHtml(mainPath)}">${escapeHtml(listing.main_category)}</a> / <a href="${escapeHtml(subPath)}">${escapeHtml(listing.sub_category)}</a></nav><article><h1>${escapeHtml(listingTitle)}</h1>${sold ? '<p>Sold</p>' : unavailable ? '<p>Temporarily unavailable</p>' : removed ? '<p>Listing is no longer available</p>' : ''}<p>${escapeHtml(listing.condition.replace('_', ' '))}</p><p>PKR ${escapeHtml(price)}</p><p>${escapeHtml(listing.description || '')}</p>${listing.image_id && listing.social_key ? `<img src="${escapeHtml(imageUrl(listing, baseUrl))}" alt="${escapeHtml(listingTitle)}" width="1200" height="630">` : ''}</article>${similar}</main>`;
  const jsonLd = buildListingJsonLd({ ...listing, status }, { canonical, mainPath, subPath, baseUrl });
  return documentHtml({
    head: pageHead({ title, description, canonical, noindex, image: imageUrl(listing, baseUrl), type: 'product' }),
    body, jsonLd, pageType: 'listing', spaEntry,
  });
}

// FR-81a, FR-82b: render home and taxonomy HTML snapshots.
function renderCollectionPage({
  title, description, path, items, baseUrl, pageType, noindex = false,
  spaEntry = resolveSpaEntry(baseUrl), jsonLd,
}) {
  const canonical = `${baseUrl}${path}`;
  const body = `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><ul>${items.map((item) => `<li><a href="${escapeHtml(canonicalListingUrl(item, baseUrl))}">${escapeHtml(effectiveListingTitle(item))}</a><span> PKR ${escapeHtml(Number(item.asking_price).toLocaleString('en-PK', { maximumFractionDigits: 2 }))}</span></li>`).join('')}</ul></main>`;
  return documentHtml({
    head: pageHead({ title, description, canonical, noindex }),
    body, pageType, spaEntry, jsonLd,
  });
}

// FR-82b: create a sitemap containing only indexable public canonical URLs.
function sitemapDocument(urls) {
  const entries = urls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

// FR-82b: create the worker-generated crawler policy and sitemap pointer.
function robotsDocument(baseUrl) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

// FR-81a: queue a versioned snapshot refresh in the listing's business transaction.
async function enqueueListingSnapshotSync(client, listingId, searchVersion) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('Listing snapshot jobs must be enqueued in the listing transaction.');
  }
  const version = String(searchVersion);
  if (!/^[1-9]\d*$/.test(version)) throw new TypeError('A valid listing search version is required.');
  return queue.enqueue(SNAPSHOT_QUEUE, { listingId, searchVersion: version }, {
    idempotencyKey: `listing:${listingId}:${version}`,
    orderingKey: 'public-site-snapshots',
    transaction: client,
  });
}

// FR-81a: enqueue the initial site-wide snapshot build when a worker starts.
async function enqueueFullSnapshotRebuild() {
  return queue.enqueue(SNAPSHOT_QUEUE, { kind: 'full' }, {
    idempotencyKey: `worker-startup:${process.pid}:${Date.now()}`,
    orderingKey: 'public-site-snapshots',
  });
}

// FR-81a, FR-82b: rebuild public HTML, sitemap, and robots pages from current PostgreSQL state.
async function processSnapshotJob(data) {
  const fullRebuild = data?.kind === 'full';
  if (!fullRebuild && (!data || typeof data.listingId !== 'string'
      || !/^[1-9]\d*$/.test(String(data.searchVersion)))) {
    throw new TypeError('Page snapshot jobs require a listing id and search version.');
  }
  return db.withTransaction(async (client) => {
    const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost').replace(/\/+$/, '');
    if (!fullRebuild) {
      const { rows: current } = await client.query('SELECT search_version FROM listings WHERE id = $1', [data.listingId]);
      if (current[0] && String(current[0].search_version) !== String(data.searchVersion)) {
        return { outcome: 'stale', paths: [] };
      }
    }
    const previous = await client.query('SELECT path FROM page_snapshots');
    const rows = [];
    const urls = [];
    const pages = new Map();
    const mainCategories = (await client.query('SELECT id, name FROM main_categories ORDER BY name')).rows;
    const subCategories = (await client.query(
      'SELECT id, main_category_id, name FROM sub_categories WHERE is_active = TRUE ORDER BY name'
    )).rows;
    const listings = (await client.query(
      `${PUBLIC_LISTING_QUERY}
       WHERE l.status IN ('published', 'sold', 'paused', 'removed', 'unpublished')
       ORDER BY l.published_at DESC NULLS LAST, l.created_at DESC, l.id`
    )).rows;
    const published = listings.filter((listing) => listing.status === 'published' && !listing.completed_order);

    const homePath = '/';
    const homeTitle = 'Poshaak | Pakistani Fashion Marketplace';
    const homeItems = published.slice(0, 12);
    const home = renderCollectionPage({
      title: homeTitle, description: 'Explore Pakistani fashion from trusted sellers.', path: homePath,
      items: homeItems, baseUrl, pageType: 'home',
      jsonLd: [
        { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Poshaak', url: `${baseUrl}/` },
        { '@context': 'https://schema.org', '@type': 'Organization', name: 'Poshaak', url: `${baseUrl}/` },
      ],
    });
    pages.set(homePath, { pageType: 'home', html: home, statusCode: 200, noindex: false });
    urls.push(`${baseUrl}${homePath}`);

    for (const main of mainCategories) {
      const mainPath = mainCategoryPath(main);
      const mainSubs = subCategories.filter((sub) => sub.main_category_id === main.id);
      const mainListings = published.filter((listing) => listing.main_category_id === main.id);
      pages.set(mainPath, {
        pageType: 'main_category', html: renderCollectionPage({
          title: `${main.name} Clothing`, description: `Shop ${main.name.toLowerCase()} fashion.`,
          path: mainPath, items: mainListings, baseUrl, pageType: 'main_category',
        }), statusCode: 200, noindex: false,
      });
      urls.push(`${baseUrl}${mainPath}`);
      for (const sub of mainSubs) {
        const subPath = subCategoryPath(main, sub);
        const subListings = published.filter((listing) => listing.sub_category_id === sub.id);
        pages.set(subPath, {
          pageType: 'sub_category', html: renderCollectionPage({
            title: `${sub.name} | ${main.name}`, description: `Shop ${sub.name.toLowerCase()} styles.`,
            path: subPath, items: subListings, baseUrl, pageType: 'sub_category',
          }), statusCode: 200, noindex: false,
        });
        urls.push(`${baseUrl}${subPath}`);
      }
    }

    const cityGroups = new Map();
    for (const listing of published) {
      if (!listing.city_name) continue;
      const key = `${listing.main_category_id}\0${listing.sub_category_id}\0${listing.city_name}`;
      if (!cityGroups.has(key)) cityGroups.set(key, listing);
    }
    for (const sample of cityGroups.values()) {
      const main = mainCategories.find((item) => item.id === sample.main_category_id);
      const sub = subCategories.find((item) => item.id === sample.sub_category_id);
      const path = categoryCityPath(main, sub, sample.city_name);
      const group = published.filter((item) => item.main_category_id === sample.main_category_id
        && item.sub_category_id === sample.sub_category_id && item.city_name === sample.city_name);
      pages.set(path, {
        pageType: 'category_city', html: renderCollectionPage({
          title: `${sub.name} in ${sample.city_name}`, description: `Shop ${sub.name.toLowerCase()} from ${sample.city_name}.`,
          path, items: group, baseUrl, pageType: 'category_city',
        }), statusCode: 200, noindex: false,
      });
      urls.push(`${baseUrl}${path}`);
    }

    for (const listing of listings) {
      const path = canonicalListingUrl(listing, '').split('?')[0];
      const code = ['removed', 'unpublished'].includes(listing.status) ? 410 : 200;
      const effectiveStatus = listing.status === 'published' && listing.completed_order ? 'sold' : listing.status;
      const similarItems = effectiveStatus === 'sold' ? similarListings(listing, published) : [];
      const html = renderListingPage({ ...listing, status: effectiveStatus }, { baseUrl, similarItems });
      const noindex = isNoindex({ pageType: 'listing', status: effectiveStatus });
      pages.set(path, { pageType: 'listing', html, statusCode: code, noindex });
      if (listing.status === 'published' && !listing.completed_order) urls.push(canonicalListingUrl(listing, baseUrl));
    }

    pages.set('/sitemap.xml', {
      pageType: 'sitemap', html: sitemapDocument(urls), statusCode: 200, noindex: false,
    });
    pages.set('/robots.txt', {
      pageType: 'robots', html: robotsDocument(baseUrl), statusCode: 200, noindex: false,
    });
    for (const [path, page] of pages) rows.push([path, page.pageType, page.html, page.statusCode, page.noindex]);

    await client.query('DELETE FROM page_snapshots');
    for (const row of rows) {
      await client.query(
        `INSERT INTO page_snapshots (path, page_type, html, status_code, noindex)
         VALUES ($1, $2, $3, $4, $5)`,
        row
      );
    }
    return {
      outcome: 'regenerated',
      paths: [...new Set([...previous.rows.map((row) => row.path), ...pages.keys()])],
    };
  });
}

// FR-81a: retrieve one generated page without user-agent-dependent rendering.
async function getSnapshot(path) {
  const { rows } = await db.read(
    'SELECT path, page_type, html, status_code, noindex FROM page_snapshots WHERE path = $1',
    [path]
  );
  return rows[0] || null;
}

// FR-82a: resolve old listing slugs to the current canonical key.
async function getCanonicalListingPath(value) {
  const parsed = parseListingUrlKey(value);
  if (!parsed) return null;
  const column = parsed.listingId ? 'id' : 'short_id';
  const key = parsed.listingId || parsed.shortId;
  const { rows } = await db.read(`SELECT slug, short_id FROM listings WHERE ${column} = $1`, [key]);
  return rows[0] ? canonicalListingUrl(rows[0], '') : null;
}

module.exports = {
  CONDITION_SCHEMA, PUBLIC_LISTING_QUERY, escapeHtml, slugify, mainCategoryPath, subCategoryPath,
  categoryCityPath, isNoindex, buildListingJsonLd, renderListingPage, renderCollectionPage, similarListings,
  sitemapDocument, robotsDocument, enqueueListingSnapshotSync, enqueueFullSnapshotRebuild,
  processSnapshotJob, getSnapshot,
  getCanonicalListingPath,
};
