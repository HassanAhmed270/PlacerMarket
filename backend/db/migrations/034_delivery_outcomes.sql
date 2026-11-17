-- Up Migration
CREATE TABLE delivery_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  outcome TEXT NOT NULL CHECK (outcome = 'refused'),
  recorded_by UUID NOT NULL REFERENCES users(id),
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 3 AND 300),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_outcomes_order_outcome_unique UNIQUE (order_id, outcome)
);

-- Down Migration
DROP TABLE delivery_outcomes;
