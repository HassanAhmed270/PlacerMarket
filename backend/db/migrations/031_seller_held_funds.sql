-- Up Migration
CREATE TABLE seller_held_funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  held_by UUID NOT NULL REFERENCES users(id),
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_7_sent_at TIMESTAMPTZ,
  reminder_30_sent_at TIMESTAMPTZ,
  reminder_90_sent_at TIMESTAMPTZ,
  needs_decision_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'released')),
  released_payout_id UUID REFERENCES seller_payouts(id),
  released_by UUID REFERENCES users(id),
  released_at TIMESTAMPTZ,
  last_decision_note TEXT,
  last_decision_by UUID REFERENCES users(id),
  last_decision_at TIMESTAMPTZ,
  CHECK (state <> 'released' OR (
    released_payout_id IS NOT NULL AND released_by IS NOT NULL AND released_at IS NOT NULL
  ))
);

CREATE INDEX seller_held_funds_state_held_at_idx
  ON seller_held_funds (state, held_at);

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record', 'payout.approve',
      'payout.export'
    ));

-- Down Migration
DROP TABLE IF EXISTS seller_held_funds;

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record', 'payout.approve'
    ));
