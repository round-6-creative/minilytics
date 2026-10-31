-- Optional: only count Stripe payments tagged with this metadata.app.
-- Needed when one Stripe account sells several products (each webhook receives every payment).
ALTER TABLE sites ADD COLUMN stripe_app TEXT;
