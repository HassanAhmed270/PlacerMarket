const { containsContactInfo } = require('./contactInfo');
const { ValidationError } = require('./errors');

const CHOICE_NOTE = "This is a recommendation based on the seller's details.";
const SEO_TITLE_LIMIT = 60;
const SEO_DESCRIPTION_LIMIT = 155;
const CONDITION_LABELS = Object.freeze({
  brand_new: 'Brand new',
  pre_owned: 'Pre-owned',
  custom_made: 'Custom made',
  replica: 'Replica',
});
const PRICE_PATTERN = /(?:\b(?:PKR|Rs\.?)\s*\d|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:PKR|Rs\.?)|[$₹]\s*\d|\b\d{3,}(?:,\d{3})*(?:\.\d{1,2})?\b)/i;

function textLength(value) {
  return Array.from(value).length;
}

function normalizeStructuredText(value) {
  if (typeof value !== 'string' || containsContactInfo(value)) return '';
  let normalized = value.trim().replace(/\s+/g, ' ').replace(/[!?.,;:]{2,}/g, (punctuation) => punctuation[0]);
  if (!normalized) return '';
  const letters = normalized.match(/\p{L}/gu) || [];
  if (letters.length >= 3 && letters.every((letter) => letter === letter.toLocaleUpperCase())) {
    normalized = normalized.toLocaleLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());
  }
  return normalized;
}

function joinWithinLimit(parts, limit) {
  let result = '';
  for (const part of parts.filter(Boolean)) {
    const next = result ? `${result} ${part}` : part;
    if (textLength(next) > limit) break;
    result = next;
  }
  return result;
}

function generateSeoRecommendation(details) {
  const condition = CONDITION_LABELS[details.condition] || '';
  const subCategory = normalizeStructuredText(details.subCategory);
  const color = normalizeStructuredText(details.color);
  const fabric = normalizeStructuredText(details.fabricMaterial);
  const brand = normalizeStructuredText(details.brand);
  const city = normalizeStructuredText(details.city);
  const isReplica = details.condition === 'replica';
  const title = joinWithinLimit([
    isReplica ? 'Replica' : condition,
    subCategory,
    brand,
    color,
    fabric,
    city && `in ${city}`,
  ], SEO_TITLE_LIMIT);
  const description = joinWithinLimit([
    condition && !isReplica ? condition : isReplica ? 'Replica' : '',
    subCategory,
    color && `in ${color}`,
    fabric && `fabric ${fabric}`,
    brand && `by ${brand}`,
    city && `in ${city}`,
  ], SEO_DESCRIPTION_LIMIT);
  return { title, description };
}

function validateSeoChoice(input, condition) {
  const hasOwnText = input.seoTitle !== undefined || input.seoDescription !== undefined;
  const choice = input.seoChoice ?? (hasOwnText ? 'custom' : 'recommended');
  if (choice !== 'recommended' && choice !== 'custom') {
    throw new ValidationError('seoChoice must be recommended or custom');
  }
  if (choice === 'recommended') {
    return { seoChoice: choice, seoTitle: null, seoDescription: null };
  }

  if (typeof input.seoTitle !== 'string' || typeof input.seoDescription !== 'string') {
    throw new ValidationError('Custom SEO text requires both a title and description');
  }
  let title = input.seoTitle.trim();
  const description = input.seoDescription.trim();
  if (!title || textLength(title) > SEO_TITLE_LIMIT) {
    throw new ValidationError(`SEO title is required and must be at most ${SEO_TITLE_LIMIT} characters`);
  }
  if (!description || textLength(description) > SEO_DESCRIPTION_LIMIT) {
    throw new ValidationError(`SEO description is required and must be at most ${SEO_DESCRIPTION_LIMIT} characters`);
  }
  if (condition === 'replica') {
    if (/\b(?:original|authentic)\b/i.test(`${title} ${description}`)) {
      throw new ValidationError('Replica listing SEO text cannot call the item original or authentic');
    }
    if (!/\breplica\b/i.test(title)) title = `Replica ${title}`;
    if (textLength(title) > SEO_TITLE_LIMIT) {
      throw new ValidationError(`SEO title is required and must be at most ${SEO_TITLE_LIMIT} characters`);
    }
  }
  for (const [label, value] of [['SEO title', title], ['SEO description', description]]) {
    const letters = value.match(/\p{L}/gu) || [];
    if (letters.length >= 3 && letters.every((letter) => letter === letter.toLocaleUpperCase())) {
      throw new ValidationError(`${label} must not be written in all caps`);
    }
    if (/(?:[!?.,;:]){3,}|[!?]{2,}/.test(value)) {
      throw new ValidationError(`${label} contains excessive punctuation`);
    }
    if (containsContactInfo(value)) {
      throw new ValidationError(`${label} must not contain contact information`);
    }
  }
  if (PRICE_PATTERN.test(description)) {
    throw new ValidationError('SEO description must not contain a price');
  }
  return { seoChoice: choice, seoTitle: title, seoDescription: description };
}

function buildSeoPayload(listing, details) {
  const recommendation = generateSeoRecommendation(details);
  const choice = listing.seo_choice === 'custom'
    ? { type: 'custom', title: listing.seo_title, description: listing.seo_description }
    : { type: 'recommended', ...recommendation };
  return { recommendation, choice, note: CHOICE_NOTE };
}

module.exports = {
  CHOICE_NOTE,
  SEO_TITLE_LIMIT,
  SEO_DESCRIPTION_LIMIT,
  generateSeoRecommendation,
  validateSeoChoice,
  buildSeoPayload,
};
