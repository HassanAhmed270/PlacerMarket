const {
  generateSeoRecommendation,
  validateSeoChoice,
  buildSeoPayload,
} = require('../../src/lib/listingSeo');

describe('FR-82 recommended and seller-selected SEO text', () => {
  test('generates a bounded recommendation from structured fields without using price', () => {
    const recommendation = generateSeoRecommendation({
      condition: 'brand_new',
      subCategory: 'Party Wear',
      color: 'Navy Blue',
      fabricMaterial: 'Silk',
      brand: 'Aster',
      city: 'Lahore',
      askingPrice: 125000,
    });

    expect(recommendation.title).toContain('Brand new');
    expect(recommendation.title).toContain('Party Wear');
    expect(recommendation.title.length).toBeLessThanOrEqual(60);
    expect(recommendation.description).toContain('Navy Blue');
    expect(recommendation.description).toContain('Silk');
    expect(recommendation.description).toContain('Aster');
    expect(recommendation.description).toContain('Lahore');
    expect(recommendation.description).not.toMatch(/125000|PKR|Rs\.?/i);
    expect(recommendation.description.length).toBeLessThanOrEqual(155);
  });

  test('always labels replica recommendations and prefixes the label to seller titles', () => {
    const recommendation = generateSeoRecommendation({
      condition: 'replica',
      subCategory: 'Bridal',
      city: 'Lahore',
    });
    expect(recommendation.title).toMatch(/^Replica\b/);

    expect(validateSeoChoice({
      seoChoice: 'custom',
      seoTitle: 'Bridal ensemble',
      seoDescription: 'Detailed replica bridal outfit in Lahore.',
    }, 'replica')).toEqual({
      seoChoice: 'custom',
      seoTitle: 'Replica Bridal ensemble',
      seoDescription: 'Detailed replica bridal outfit in Lahore.',
    });
    expect(() => validateSeoChoice({
      seoChoice: 'custom',
      seoTitle: 'Original bridal wear',
      seoDescription: 'Authentic piece from Lahore.',
    }, 'replica')).toThrow(/cannot call the item original or authentic/);
  });

  test('rejects seller text exceeding limits, all-caps, excessive punctuation, contact details, or prices', () => {
    const ownText = {
      seoChoice: 'custom',
      seoTitle: 'Navy party wear',
      seoDescription: 'A polished navy silk outfit.',
    };
    expect(() => validateSeoChoice({ ...ownText, seoTitle: 'x'.repeat(61) }, 'brand_new'))
      .toThrow(/at most 60 characters/);
    expect(() => validateSeoChoice({ ...ownText, seoDescription: 'x'.repeat(156) }, 'brand_new'))
      .toThrow(/at most 155 characters/);
    expect(() => validateSeoChoice({ ...ownText, seoTitle: 'NAVY PARTY WEAR' }, 'brand_new'))
      .toThrow(/all caps/);
    expect(() => validateSeoChoice({ ...ownText, seoTitle: 'Navy party wear!!!' }, 'brand_new'))
      .toThrow(/excessive punctuation/);
    expect(() => validateSeoChoice({ ...ownText, seoDescription: 'Call +1 (555) 123-4567 for details.' }, 'brand_new'))
      .toThrow(/contact information/);
    expect(() => validateSeoChoice({ ...ownText, seoDescription: 'Available for PKR 12,000.' }, 'brand_new'))
      .toThrow(/must not contain a price/);
  });

  test('returns both the recommendation and the seller choice with the recommendation note', () => {
    const payload = buildSeoPayload({
      seo_choice: 'custom',
      seo_title: 'My own title',
      seo_description: 'My own description',
    }, { condition: 'pre_owned', subCategory: 'Sherwani' });

    expect(payload).toMatchObject({
      recommendation: { title: expect.any(String), description: expect.any(String) },
      choice: { type: 'custom', title: 'My own title', description: 'My own description' },
      note: expect.stringMatching(/recommendation based on the seller's details/i),
    });
  });
});
