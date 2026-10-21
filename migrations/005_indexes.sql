CREATE INDEX IF NOT EXISTS idx_leave_operations_year_start ON leave_operations (year, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_adjustments_year_date ON leave_adjustments (year, adjustment_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_audit_created_at ON leave_audit_log (created_at DESC);
