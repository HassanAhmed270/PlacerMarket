const catalog = require('../../src/modules/catalog.service');
const { ValidationError } = require('../../src/lib/errors');

describe('catalog.service pure validations', () => {
  test('FR-13: listConditionTypes returns the fixed 4 types', () => {
    expect(catalog.listConditionTypes()).toEqual(['brand_new', 'pre_owned', 'custom_made', 'replica']);
  });

  test('FR-14: replica without disclosure is rejected', () => {
    expect(() =>
      catalog.assertReplicaDisclosureIfNeeded({ condition: 'replica', replicaDisclosure: null })
    ).toThrow(ValidationError);
  });

  test('FR-14: replica WITH disclosure passes', () => {
    expect(() =>
      catalog.assertReplicaDisclosureIfNeeded({ condition: 'replica', replicaDisclosure: 'Inspired-design, not authentic brand' })
    ).not.toThrow();
  });

  test('FR-14: non-replica condition never needs disclosure', () => {
    expect(() => catalog.assertReplicaDisclosureIfNeeded({ condition: 'pre_owned' })).not.toThrow();
  });

  test('FR-14a: rental listing type is rejected (deferred, not MVP)', () => {
    expect(() => catalog.assertNotRentalListing({ listingType: 'rental' })).toThrow(ValidationError);
  });

  test('FR-14a: buy listing type passes', () => {
    expect(() => catalog.assertNotRentalListing({ listingType: 'buy' })).not.toThrow();
  });
});
