-- Broadcast "something about the sale changed" to every API instance.
-- Each instance LISTENs on this channel and pushes fresh state to its open
-- status pages (SSE). Statement-level, and Postgres folds identical
-- notifications in one transaction, so a burst costs one notify per commit.
CREATE FUNCTION notify_sale_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('sale_changed', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER holds_notify AFTER INSERT OR UPDATE OR DELETE ON holds
  FOR EACH STATEMENT EXECUTE FUNCTION notify_sale_changed();
CREATE TRIGGER waitlist_notify AFTER INSERT OR UPDATE OR DELETE ON waitlist
  FOR EACH STATEMENT EXECUTE FUNCTION notify_sale_changed();
CREATE TRIGGER payment_events_notify AFTER INSERT OR UPDATE ON payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION notify_sale_changed();
