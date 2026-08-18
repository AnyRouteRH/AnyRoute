-- Ledger is append-only: corrections are new rows, never edits.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- accounts.balance is always exactly the sum of that account's ledger rows.
CREATE OR REPLACE FUNCTION ledger_apply() RETURNS trigger AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger row for unknown account %', NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_apply_balance AFTER INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_apply();
--> statement-breakpoint
-- accounts.held is always exactly the sum of that account's open holds.
CREATE OR REPLACE FUNCTION holds_apply() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'held' THEN
      UPDATE accounts SET held = held + NEW.amount WHERE id = NEW.account_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.amount <> NEW.amount OR OLD.account_id <> NEW.account_id THEN
      RAISE EXCEPTION 'hold amount/account are immutable';
    END IF;
    IF OLD.status = 'held' AND NEW.status <> 'held' THEN
      UPDATE accounts SET held = held - OLD.amount WHERE id = OLD.account_id;
    ELSIF OLD.status <> 'held' AND NEW.status = 'held' THEN
      RAISE EXCEPTION 'a closed hold cannot be reopened';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds are never deleted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER holds_apply_held AFTER INSERT OR UPDATE OR DELETE ON holds
  FOR EACH ROW EXECUTE FUNCTION holds_apply();
--> statement-breakpoint
-- Time-series tables become Timescale hypertables when the extension is available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('health', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('canaries', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END
$$;
