-- Why a waitlist entry left the line: user_left (they quit) or skipped_limit
-- (their turn came but they had already hit the per-person limit / were holding).
ALTER TABLE waitlist ADD COLUMN left_reason TEXT
  CHECK (left_reason IN ('user_left', 'skipped_limit', 'skipped_holding'));

UPDATE waitlist SET left_reason = 'user_left' WHERE status = 'left';

ALTER TABLE waitlist ADD CONSTRAINT waitlist_left_has_reason
  CHECK ((status = 'left') = (left_reason IS NOT NULL));
