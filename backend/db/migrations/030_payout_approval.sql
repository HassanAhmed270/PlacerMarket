-- Up Migration
ALTER TABLE seller_payouts
  ADD COLUMN approved_by UUID REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD CONSTRAINT seller_payouts_approval_fields_check
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT seller_payouts_approval_distinct_initiator_check
    CHECK (approved_by IS NULL OR approved_by <> initiated_by);

INSERT INTO platform_settings (key, value)
VALUES ('payout_two_admin_threshold', '50000')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record', 'payout.approve'
    ));

-- Down Migration
ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record'
    ));

DELETE FROM platform_settings
  WHERE key = 'payout_two_admin_threshold';

ALTER TABLE seller_payouts
  DROP CONSTRAINT seller_payouts_approval_fields_check,
  DROP CONSTRAINT seller_payouts_approval_distinct_initiator_check,
  DROP COLUMN approved_by,
  DROP COLUMN approved_at;
