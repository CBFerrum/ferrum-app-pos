-- Live loyalty earnings by expiry date: the expiry job reads only what is due, never the history.
create index if not exists ix_loyalty_point_entry_live_expiry on e_loyalty_point_entry (tenant_id, expiry_date) where remaining > 0;
