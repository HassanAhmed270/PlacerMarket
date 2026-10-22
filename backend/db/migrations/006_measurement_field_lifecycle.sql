-- Expand measurement definitions for required and retired fields (FR-15a).
ALTER TABLE measurement_field_defs
  ADD COLUMN required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
