-- Up Migration
ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record', 'payout.approve',
      'payout.export', 'commission.update'
    ));

-- Down Migration
ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record', 'payout.approve',
      'payout.export'
    ));
