-- WorkWorld Merchandise Planning & Operations — app-facing views (the API contract).
-- Exported live from sset1000.information_schema.views (2026-07-15).
-- The application reads ONLY these views (plus 4 whitelisted registry tables:
-- markdown_policy, experiments, data_health, dim_vendor). Demo anchor date 2026-07-14
-- appears as a literal in several views; production replaces it with current_date().

-- size_run_health_v
CREATE OR REPLACE VIEW sset1000.supplychain.size_run_health_v AS
SELECT f.store_id, b.style_id, b.brand, b.style_name, b.color,
  count(*) AS sizes_carried,
  sum(CASE WHEN f.on_hand=0 THEN 1 ELSE 0 END) AS sizes_out,
  sum(CASE WHEN f.on_hand=0 AND coalesce(sc.meat_size,false) THEN 1 ELSE 0 END) AS meat_sizes_out,
  CASE WHEN sum(CASE WHEN f.on_hand=0 AND coalesce(sc.meat_size,false) THEN 1 ELSE 0 END) > 0 THEN 'MeatBreak'
       WHEN sum(CASE WHEN f.on_hand=0 THEN 1 ELSE 0 END) > 0 THEN 'FringeBreak'
       ELSE 'Intact' END AS run_status,
  min(f.proj_stockout_date) AS next_proj_stockout
FROM sset1000.supplychain.fact_inventory_daily f
JOIN sset1000.supplychain.demand_base b ON b.store_id=f.store_id AND b.sku_id=f.sku_id
JOIN sset1000.supplychain.dim_style st ON st.style_id=b.style_id
LEFT JOIN sset1000.supplychain.size_curves sc ON sc.curve_id=st.size_curve_id AND sc.size=b.size
WHERE f.snapshot_date = date'2026-07-13'
GROUP BY 1,2,3,4,5;

-- replen_queue_v
CREATE OR REPLACE VIEW sset1000.supplychain.replen_queue_v AS
SELECT r.suggestion_id, r.store_id, s.store_name, r.sku_id, b.brand, b.style_name, b.color, b.size,
  r.action, r.suggested_qty, r.proj_stockout_date, datediff(r.proj_stockout_date, date'2026-07-14') AS days_to_stockout,
  r.reason, r.tier_break_note, r.status, v.vendor_name
FROM sset1000.supplychain.replen_suggestions r
JOIN sset1000.supplychain.dim_store s ON s.store_id = r.store_id
LEFT JOIN (SELECT DISTINCT sku_id, store_id, brand, style_name, color, size, vendor_id FROM sset1000.supplychain.demand_base) b ON b.sku_id = r.sku_id AND b.store_id = r.store_id
LEFT JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = b.vendor_id;

-- exception_queue_v
CREATE OR REPLACE VIEW sset1000.supplychain.exception_queue_v AS
SELECT m.match_id, m.po_id, m.invoice_id, m.sku_id, v.vendor_name, h.ship_to_store AS store_id,
  m.variance_type, m.variance_amount, m.ai_suggested_resolution, m.status,
  m.invoice_date, datediff(date'2026-07-14', m.invoice_date) AS age_days,
  b.brand, b.style_name, b.size
FROM sset1000.supplychain.threeway_match m
JOIN sset1000.supplychain.po_header h ON h.po_id = m.po_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = m.vendor_id
LEFT JOIN (SELECT DISTINCT sku_id, brand, style_name, size FROM sset1000.supplychain.demand_base) b ON b.sku_id = m.sku_id
WHERE m.status IN ('PendingReview','DebitMemoSent');

-- match_trend_v
CREATE OR REPLACE VIEW sset1000.supplychain.match_trend_v AS
SELECT date_trunc('month', invoice_date) AS match_month,
  count(*) AS matched_lines,
  round(100.0*sum(CASE WHEN variance_type='None' THEN 1 ELSE 0 END)/count(*),1) AS auto_clear_pct,
  round(sum(CASE WHEN variance_type <> 'None' THEN variance_amount ELSE 0 END),0) AS variance_identified,
  round(sum(CASE WHEN status IN ('Resolved','DebitMemoSent') AND variance_type <> 'None' THEN variance_amount ELSE 0 END),0) AS variance_recovered,
  round(sum(CASE WHEN status='PendingReview' THEN variance_amount ELSE 0 END),0) AS variance_open
FROM sset1000.supplychain.threeway_match
GROUP BY 1;

-- po_document_tree_v
CREATE OR REPLACE VIEW sset1000.supplychain.po_document_tree_v AS
WITH lines AS (
  SELECT po_id, count(*) AS line_count, sum(qty_ordered) AS qty_ordered, sum(qty_received) AS qty_received,
    sum(qty_cancelled) AS qty_cancelled, round(sum(qty_ordered*unit_cost),2) AS po_value
  FROM sset1000.supplychain.po_line GROUP BY po_id
),
exc AS (
  SELECT po_id, sum(CASE WHEN status IN ('PendingReview','DebitMemoSent') THEN 1 ELSE 0 END) AS open_exceptions,
    round(sum(CASE WHEN status IN ('PendingReview','DebitMemoSent') THEN variance_amount ELSE 0 END),2) AS open_exception_amt,
    sum(CASE WHEN variance_type <> 'None' THEN 1 ELSE 0 END) AS total_exceptions
  FROM sset1000.supplychain.threeway_match GROUP BY po_id
)
SELECT h.master_po_id, mh.order_date AS master_order_date, mh.po_type, v.vendor_name,
  h.po_id, h.ship_to_store AS store_id, s.store_name, h.order_date, h.requested_ship,
  h.edi_855_ack, h.status AS po_status,
  coalesce(l.line_count,0) AS line_count, coalesce(l.qty_ordered,0) AS qty_ordered,
  coalesce(l.qty_received,0) AS qty_received, coalesce(l.qty_cancelled,0) AS qty_cancelled,
  coalesce(l.po_value,0) AS po_value,
  r.receiver_id, r.received_date, r.status AS receiver_status,
  i.invoice_id, i.total_amount AS invoice_total, i.master_statement_id,
  CASE WHEN i.invoice_id IS NULL THEN NULL
       WHEN coalesce(e.open_exceptions,0) > 0 THEN 'Exception'
       WHEN coalesce(e.total_exceptions,0) > 0 THEN 'Resolved'
       ELSE 'Matched' END AS invoice_status,
  coalesce(e.open_exceptions,0) AS open_exceptions, coalesce(e.open_exception_amt,0) AS open_exception_amt,
  coalesce(e.total_exceptions,0) AS total_exceptions
FROM sset1000.supplychain.po_header h
JOIN sset1000.supplychain.po_header mh ON mh.po_id = h.master_po_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = h.vendor_id
LEFT JOIN sset1000.supplychain.dim_store s ON s.store_id = h.ship_to_store
LEFT JOIN lines l ON l.po_id = h.po_id
LEFT JOIN sset1000.supplychain.receiver_header r ON r.po_id = h.po_id
LEFT JOIN sset1000.supplychain.invoice_header i ON i.po_id = h.po_id
LEFT JOIN exc e ON e.po_id = h.po_id
WHERE h.po_level='Store';

-- sales_trend_v
CREATE OR REPLACE VIEW sset1000.supplychain.sales_trend_v AS
SELECT date_trunc('week', sales_date) AS week_start,
  round(sum(net_sales),0) AS net_sales, round(sum(margin_dollars),0) AS margin_dollars, sum(units) AS units,
  round(sum(CASE WHEN weather_rain_flag THEN net_sales ELSE 0 END),0) AS rain_day_sales,
  round(sum(CASE WHEN promo_flag THEN net_sales ELSE 0 END),0) AS promo_sales
FROM sset1000.supplychain.fact_sales_daily
GROUP BY 1 ORDER BY 1;

-- price_event_pipeline_v
CREATE OR REPLACE VIEW sset1000.supplychain.price_event_pipeline_v AS
WITH tasks AS (
  SELECT related_event, count(*) AS tasks_total,
    sum(CASE WHEN status='Done' THEN 1 ELSE 0 END) AS tasks_done,
    sum(CASE WHEN status='Overdue' THEN 1 ELSE 0 END) AS tasks_overdue
  FROM sset1000.supplychain.store_tasks GROUP BY related_event
)
SELECT e.event_id, e.event_type, coalesce(v.vendor_name,'(internal)') AS vendor_name, e.scope,
  e.skus_affected, e.effective_date,
  datediff(e.effective_date, date'2026-07-14') AS days_to_effective,
  e.erp_updated, e.stores_notified, e.label_file_generated,
  CASE WHEN e.erp_updated AND e.stores_notified AND e.label_file_generated THEN 'Executed'
       WHEN e.erp_updated THEN 'ERP updated'
       WHEN e.effective_date <= date'2026-07-14' THEN 'OVERDUE - not staged'
       ELSE 'Announced' END AS workflow_state,
  coalesce(t.tasks_total,0) AS tasks_total, coalesce(t.tasks_done,0) AS tasks_done, coalesce(t.tasks_overdue,0) AS tasks_overdue,
  c.subject AS comm_subject,
  CASE WHEN c.sent_at IS NOT NULL THEN 'Sent' WHEN c.comm_id IS NOT NULL THEN 'Drafted - awaiting approval' ELSE 'Not drafted' END AS comm_status
FROM sset1000.supplychain.price_change_events e
LEFT JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = e.vendor_id
LEFT JOIN tasks t ON t.related_event = e.event_id
LEFT JOIN sset1000.supplychain.comms_log c ON c.comm_id = e.comm_id;

-- markdown_ladder_v
CREATE OR REPLACE VIEW sset1000.supplychain.markdown_ladder_v AS
WITH steps AS (
  SELECT * FROM VALUES
   ('MD-001','C-220',0,'Regular',0.00),('MD-001','C-220',1,'Step 1: 20% off',0.20),
   ('MD-001','C-220',2,'Step 2: 30% off',0.30),('MD-001','C-220',3,'Step 3: 50% off',0.50),
   ('MD-002','C-221',0,'Regular',0.00),('MD-002','C-221',1,'Step 1: 25% off',0.25),
   ('MD-002','C-221',2,'Step 2: 40% off',0.40),('MD-002','C-221',3,'Step 3: clearance 60% off',0.60),
   ('MD-002','C-211',0,'Regular',0.00),('MD-002','C-211',1,'Step 1: 25% off',0.25),
   ('MD-002','C-211',2,'Step 2: 40% off',0.40),('MD-002','C-211',3,'Step 3: clearance 60% off',0.60)
  AS v(policy_id, category_id, step_no, step_label, disc_pct)
)
SELECT st.style_id, st.brand, st.style_name, c.category, c.subcategory,
  s.policy_id, p.scope AS policy_scope, s.step_no, s.step_label, round(100*s.disc_pct,0) AS disc_pct,
  st.base_retail AS regular_retail,
  round(st.base_retail * (1 - s.disc_pct), 2) AS step_price,
  st.base_cost,
  round(100 * (st.base_retail*(1-s.disc_pct) - st.base_cost) / (st.base_retail*(1-s.disc_pct)), 1) AS step_margin_pct,
  round(100 * p.floor_margin_pct, 0) AS floor_margin_pct,
  CASE WHEN (st.base_retail*(1-s.disc_pct) - st.base_cost) / (st.base_retail*(1-s.disc_pct)) < p.floor_margin_pct THEN true ELSE false END AS below_floor
FROM steps s
JOIN sset1000.supplychain.dim_style st ON st.category_id = s.category_id
JOIN sset1000.supplychain.dim_category c ON c.category_id = st.category_id
JOIN sset1000.supplychain.markdown_policy p ON p.policy_id = s.policy_id;

-- lead_time_variance_v
CREATE OR REPLACE VIEW sset1000.supplychain.lead_time_variance_v AS
SELECT r.receiver_id, r.po_id, h.vendor_id, v.vendor_name, v.sophistication,
  h.ship_to_store AS store_id, h.po_type,
  h.order_date, h.requested_ship, r.received_date,
  datediff(r.received_date, h.order_date) AS actual_lead_days,
  coalesce(lt.quoted_lead_days, 21) AS quoted_lead_days,
  datediff(r.received_date, h.order_date) - coalesce(lt.quoted_lead_days, 21) AS variance_days,
  CASE WHEN datediff(r.received_date, h.order_date) - coalesce(lt.quoted_lead_days,21) > 7 THEN 'Late 7+'
       WHEN datediff(r.received_date, h.order_date) - coalesce(lt.quoted_lead_days,21) > 0 THEN 'Late'
       WHEN datediff(r.received_date, h.order_date) - coalesce(lt.quoted_lead_days,21) >= -3 THEN 'On time'
       ELSE 'Early' END AS timeliness
FROM sset1000.supplychain.receiver_header r
JOIN sset1000.supplychain.po_header h ON h.po_id = r.po_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = h.vendor_id
LEFT JOIN (SELECT vendor_id, max(quoted_lead_days) AS quoted_lead_days FROM sset1000.supplychain.vendor_lead_times GROUP BY 1) lt
  ON lt.vendor_id = h.vendor_id;

-- size_demand_v
CREATE OR REPLACE VIEW sset1000.supplychain.size_demand_v AS
WITH actual AS (
  SELECT f.store_id, b.category, b.brand, b.size, round(sum(f.units)/8.0,2) AS actual_weekly_units
  FROM sset1000.supplychain.fact_sales_daily f
  JOIN (SELECT DISTINCT store_id, sku_id, category, brand, size FROM sset1000.supplychain.demand_base) b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  WHERE f.sales_date >= date'2026-05-19'
  GROUP BY 1,2,3,4
),
fc AS (
  SELECT f.store_id, b.category, b.brand, b.size,
    round(sum(f.forecast_units + f.weather_adj_units)/8.0,2) AS forecast_weekly_units
  FROM sset1000.supplychain.demand_forecast f
  JOIN (SELECT DISTINCT store_id, sku_id, category, brand, size FROM sset1000.supplychain.demand_base) b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  GROUP BY 1,2,3,4
),
curve AS (
  SELECT b.category, b.brand, b.size, max(sc.pct_units) AS pct_units, max(coalesce(sc.meat_size,false)) AS meat_size
  FROM (SELECT DISTINCT style_id, category, brand, size FROM sset1000.supplychain.demand_base) b
  JOIN sset1000.supplychain.dim_style st ON st.style_id=b.style_id
  LEFT JOIN sset1000.supplychain.size_curves sc ON sc.curve_id=st.size_curve_id AND sc.size=b.size
  GROUP BY 1,2,3
)
SELECT coalesce(a.store_id, f.store_id) AS store_id,
  coalesce(a.category, f.category) AS category,
  coalesce(a.brand, f.brand) AS brand,
  coalesce(a.size, f.size) AS size,
  coalesce(a.actual_weekly_units, 0) AS actual_weekly_units,
  coalesce(f.forecast_weekly_units, 0) AS forecast_weekly_units,
  c.pct_units AS size_curve_share, coalesce(c.meat_size, false) AS meat_size
FROM actual a
FULL OUTER JOIN fc f ON f.store_id=a.store_id AND f.category=a.category AND f.brand=a.brand AND f.size=a.size
LEFT JOIN curve c ON c.category=coalesce(a.category,f.category) AND c.brand=coalesce(a.brand,f.brand) AND c.size=coalesce(a.size,f.size);

-- forecast_summary_v
CREATE OR REPLACE VIEW sset1000.supplychain.forecast_summary_v AS
SELECT f.forecast_week, b.category, b.subcategory,
  round(sum(f.forecast_units),0) AS forecast_units,
  round(sum(f.weather_adj_units),0) AS weather_adj_units
FROM sset1000.supplychain.demand_forecast f
JOIN (SELECT DISTINCT store_id, sku_id, category, subcategory FROM sset1000.supplychain.demand_base) b
  ON b.store_id = f.store_id AND b.sku_id = f.sku_id
GROUP BY 1,2,3;

-- prebuy_analysis_v
CREATE OR REPLACE VIEW sset1000.supplychain.prebuy_analysis_v AS
WITH increases AS (
  SELECT 'PC-501' AS event_id, 'V001' AS vendor_id, date'2026-08-01' AS effective_date, 0.055 AS cost_increase_pct
  UNION ALL SELECT 'PC-503','V004', date'2026-09-01', 0.03
  UNION ALL SELECT 'PC-506','V008', date'2026-10-01', 0.04
),
rate AS (
  SELECT b.vendor_id, b.style_id, b.brand, b.style_name, max(b.base_cost) AS unit_cost,
    sum(f.units)/8.0 AS weekly_units
  FROM sset1000.supplychain.fact_sales_daily f
  JOIN (SELECT DISTINCT store_id, sku_id, vendor_id, style_id, brand, style_name, base_cost FROM sset1000.supplychain.demand_base) b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  WHERE f.sales_date >= date'2026-05-19'
  GROUP BY 1,2,3,4
)
SELECT i.event_id, v.vendor_name, r.style_id, r.brand, r.style_name,
  i.effective_date, datediff(i.effective_date, date'2026-07-14') AS days_to_effective,
  round(100*i.cost_increase_pct,1) AS cost_increase_pct,
  round(r.weekly_units,1) AS weekly_units,
  r.unit_cost AS current_cost,
  round(r.unit_cost * i.cost_increase_pct, 2) AS delta_per_unit,
  6 AS guardrail_weeks,
  CAST(ceil(r.weekly_units * 6) AS INT) AS suggested_prebuy_qty,
  round(ceil(r.weekly_units * 6) * r.unit_cost * i.cost_increase_pct, 0) AS prebuy_savings,
  round(ceil(r.weekly_units * 6) * r.unit_cost, 0) AS prebuy_cash_outlay
FROM increases i
JOIN rate r ON r.vendor_id = i.vendor_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = i.vendor_id
WHERE r.weekly_units > 0.2;

-- proposed_po_v
CREATE OR REPLACE VIEW sset1000.supplychain.proposed_po_v AS
WITH pos AS (
  SELECT store_id, sku_id, on_hand + on_order + in_transit AS position
  FROM sset1000.supplychain.fact_inventory_daily WHERE snapshot_date = date'2026-07-13'
),
fc AS (
  SELECT store_id, sku_id,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 14) THEN forecast_units ELSE 0 END) AS fc_2wk,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 28) THEN forecast_units ELSE 0 END) AS fc_4wk,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 42) THEN forecast_units ELSE 0 END) AS fc_6wk,
    sum(forecast_units) AS fc_8wk,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 14) THEN weather_adj_units ELSE 0 END) AS wx_2wk,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 28) THEN weather_adj_units ELSE 0 END) AS wx_4wk,
    sum(CASE WHEN forecast_week < date_add(date'2026-07-14', 42) THEN weather_adj_units ELSE 0 END) AS wx_6wk,
    sum(weather_adj_units) AS wx_8wk
  FROM sset1000.supplychain.demand_forecast GROUP BY 1,2
)
SELECT b.store_id, s.store_name, s.climate_zone, b.sku_id, b.brand, b.style_name, b.color, b.size,
  b.category, b.vendor_id, v.vendor_name, b.base_cost AS unit_cost,
  coalesce(p.position, 0) AS position,
  coalesce(sp.safety_stock, 1) AS safety_stock,
  coalesce(sp.max_units, 10) AS max_units,
  round(coalesce(f.fc_2wk,0),1) AS fc_2wk, round(coalesce(f.fc_4wk,0),1) AS fc_4wk,
  round(coalesce(f.fc_6wk,0),1) AS fc_6wk, round(coalesce(f.fc_8wk,0),1) AS fc_8wk,
  round(coalesce(f.wx_2wk,0),1) AS wx_2wk, round(coalesce(f.wx_4wk,0),1) AS wx_4wk,
  round(coalesce(f.wx_6wk,0),1) AS wx_6wk, round(coalesce(f.wx_8wk,0),1) AS wx_8wk,
  coalesce(lt.lead_days, 21) AS lead_days_p50,
  coalesce(lt.moq, 1) AS moq_units,
  date_add(date'2026-07-14', coalesce(lt.lead_days, 21)) AS expected_receipt,
  CASE WHEN b.vendor_id='V001' THEN 'Consolidate to 288-unit tier (OPP-2026-011)'
       WHEN b.vendor_id='V012' THEN 'Preseason book pricing (OPP-2026-013)' ELSE '' END AS tier_break_note
FROM (SELECT DISTINCT store_id, sku_id, brand, style_name, color, size, category, vendor_id, base_cost FROM sset1000.supplychain.demand_base WHERE replenishable) b
JOIN sset1000.supplychain.dim_store s ON s.store_id = b.store_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = b.vendor_id
LEFT JOIN pos p ON p.store_id = b.store_id AND p.sku_id = b.sku_id
LEFT JOIN sset1000.supplychain.store_sku_params sp ON sp.store_id = b.store_id AND sp.sku_id = b.sku_id
LEFT JOIN fc f ON f.store_id = b.store_id AND f.sku_id = b.sku_id
LEFT JOIN (SELECT vendor_id, max(actual_lead_days_p50) AS lead_days, max(moq_units) AS moq FROM sset1000.supplychain.vendor_lead_times GROUP BY 1) lt
  ON lt.vendor_id = b.vendor_id;

-- ats_coverage_v
CREATE OR REPLACE VIEW sset1000.supplychain.ats_coverage_v AS
SELECT a.vendor_id, v.vendor_name, v.sophistication, a.capture_method,
  count(*) AS items_reported,
  sum(CASE WHEN a.sku_id IS NOT NULL THEN 1 ELSE 0 END) AS items_matched,
  round(100.0*sum(CASE WHEN a.sku_id IS NOT NULL THEN 1 ELSE 0 END)/count(*),1) AS match_rate_pct,
  sum(CASE WHEN a.ats_units = 0 THEN 1 ELSE 0 END) AS zero_ats_items,
  min(a.next_avail_date) AS earliest_next_avail
FROM sset1000.supplychain.vendor_ats a
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = a.vendor_id
WHERE a.snapshot_date = date'2026-07-13'
GROUP BY 1,2,3,4;

-- price_impact_v
CREATE OR REPLACE VIEW sset1000.supplychain.price_impact_v AS
WITH old_p AS (SELECT sku_id, unit_cost, retail_price FROM sset1000.supplychain.price_master WHERE effective_date=date'2026-01-01' AND price_type='Regular'),
new_p AS (SELECT sku_id, unit_cost, retail_price FROM sset1000.supplychain.price_master WHERE effective_date=date'2026-08-01' AND price_type='Regular'),
rate AS (
  SELECT b.style_id, sum(f.units)/8.0 AS weekly_units
  FROM sset1000.supplychain.fact_sales_daily f
  JOIN (SELECT DISTINCT store_id, sku_id, style_id FROM sset1000.supplychain.demand_base) b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  WHERE f.sales_date >= date'2026-05-19'
  GROUP BY 1
)
SELECT st.style_id, st.brand, st.style_name, c.category,
  date'2026-08-01' AS effective_date,
  round(avg(o.unit_cost),2) AS old_cost, round(avg(n.unit_cost),2) AS new_cost,
  round(avg(o.retail_price),2) AS old_retail, round(avg(n.retail_price),2) AS new_retail,
  round(100*(avg(o.retail_price)-avg(o.unit_cost))/avg(o.retail_price),1) AS old_margin_pct,
  round(100*(avg(n.retail_price)-avg(n.unit_cost))/avg(n.retail_price),1) AS new_margin_pct,
  round(coalesce(max(r.weekly_units),0),1) AS weekly_units,
  round(coalesce(max(r.weekly_units),0) * ((avg(n.retail_price)-avg(n.unit_cost)) - (avg(o.retail_price)-avg(o.unit_cost))) * 52, 0) AS annual_margin_delta
FROM new_p n
JOIN old_p o ON o.sku_id = n.sku_id
JOIN sset1000.supplychain.dim_sku k ON k.sku_id = n.sku_id
JOIN sset1000.supplychain.dim_style st ON st.style_id = k.style_id
JOIN sset1000.supplychain.dim_category c ON c.category_id = st.category_id
LEFT JOIN rate r ON r.style_id = st.style_id
GROUP BY st.style_id, st.brand, st.style_name, c.category;

-- store_variance_v
CREATE OR REPLACE VIEW sset1000.supplychain.store_variance_v AS
WITH actual AS (
  SELECT f.store_id, b.category, b.brand, b.size, sum(f.units) AS actual_units, round(sum(f.net_sales),0) AS actual_sales
  FROM sset1000.supplychain.fact_sales_daily f
  JOIN (SELECT DISTINCT store_id, sku_id, category, brand, size FROM sset1000.supplychain.demand_base) b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  WHERE f.sales_date >= date'2026-05-19'
  GROUP BY 1,2,3,4
),
expected AS (
  SELECT b.store_id, b.category, b.brand, b.size,
    round(sum(b.base_daily_units * 56 * coalesce(s.demand_index,1.0)),1) AS expected_units
  FROM sset1000.supplychain.demand_base b
  LEFT JOIN (SELECT curve_id, avg(demand_index) AS demand_index FROM sset1000.supplychain.seasonality_curves WHERE month_num IN (5,6,7) GROUP BY 1) s
    ON s.curve_id=b.seasonality_id
  GROUP BY 1,2,3,4
),
inv AS (
  SELECT f.store_id, b.category, b.brand, b.size,
    count(*) AS positions,
    sum(CASE WHEN f.on_hand=0 THEN 1 ELSE 0 END) AS outs,
    sum(CASE WHEN f.on_hand=0 AND coalesce(sc.meat_size,false) THEN 1 ELSE 0 END) AS meat_outs
  FROM sset1000.supplychain.fact_inventory_daily f
  JOIN sset1000.supplychain.demand_base b ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  JOIN sset1000.supplychain.dim_style st ON st.style_id=b.style_id
  LEFT JOIN sset1000.supplychain.size_curves sc ON sc.curve_id=st.size_curve_id AND sc.size=b.size
  WHERE f.snapshot_date=date'2026-07-13'
  GROUP BY 1,2,3,4
),
lost AS (
  SELECT e.store_id, b.category, b.brand, b.size, round(sum(e.est_lost_sales),0) AS lost_sales
  FROM sset1000.supplychain.stockout_events e
  JOIN (SELECT DISTINCT store_id, sku_id, category, brand, size FROM sset1000.supplychain.demand_base) b
    ON b.store_id=e.store_id AND b.sku_id=e.sku_id
  GROUP BY 1,2,3,4
)
SELECT e.store_id, s.store_name, s.latitude, s.longitude, e.category, e.brand, e.size,
  coalesce(a.actual_units,0) AS actual_units, coalesce(a.actual_sales,0) AS actual_sales,
  e.expected_units,
  round(100.0*(coalesce(a.actual_units,0) - e.expected_units)/greatest(e.expected_units,0.1),1) AS variance_pct,
  coalesce(i.positions,0) AS positions, coalesce(i.outs,0) AS outs, coalesce(i.meat_outs,0) AS meat_outs,
  coalesce(l.lost_sales,0) AS lost_sales
FROM expected e
JOIN sset1000.supplychain.dim_store s ON s.store_id=e.store_id
LEFT JOIN actual a ON a.store_id=e.store_id AND a.category=e.category AND a.brand=e.brand AND a.size=e.size
LEFT JOIN inv i ON i.store_id=e.store_id AND i.category=e.category AND i.brand=e.brand AND i.size=e.size
LEFT JOIN lost l ON l.store_id=e.store_id AND l.category=e.category AND l.brand=e.brand AND l.size=e.size;

-- markdown_season_v
CREATE OR REPLACE VIEW sset1000.supplychain.markdown_season_v AS
WITH rain AS (
  SELECT f.sales_date, f.units, f.net_sales, f.margin_dollars
  FROM sset1000.supplychain.fact_sales_daily f
  JOIN (SELECT DISTINCT store_id, sku_id FROM sset1000.supplychain.demand_base WHERE category_id='C-220') b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
),
wk AS (
  SELECT date_trunc('week', sales_date) AS week_start, sum(units) AS units,
    round(sum(net_sales),0) AS net_sales, round(sum(margin_dollars),0) AS margin_dollars,
    round(sum(net_sales)/greatest(sum(units),1),2) AS realized_price
  FROM rain GROUP BY 1
),
oh AS (
  SELECT sum(f.on_hand) AS on_hand_now
  FROM sset1000.supplychain.fact_inventory_daily f
  JOIN (SELECT DISTINCT store_id, sku_id FROM sset1000.supplychain.demand_base WHERE category_id='C-220') b
    ON b.store_id=f.store_id AND b.sku_id=f.sku_id
  WHERE f.snapshot_date = date'2026-07-13'
),
tot AS (SELECT sum(units) AS season_units FROM wk)
SELECT w.week_start, w.units, w.net_sales, w.margin_dollars, w.realized_price,
  sum(w.units) OVER (ORDER BY w.week_start) AS cum_units,
  t.season_units + coalesce(o.on_hand_now, CAST(round(t.season_units*0.25) AS BIGINT)) AS est_season_supply,
  round(100.0 * sum(w.units) OVER (ORDER BY w.week_start) / (t.season_units + coalesce(o.on_hand_now, CAST(round(t.season_units*0.25) AS BIGINT))), 1) AS cum_sell_through_pct,
  CASE WHEN w.week_start = date_trunc('week', date'2026-06-15') THEN 'Step 1: 20% off (executed)'
       WHEN w.week_start = date_trunc('week', date'2026-07-13') THEN 'Step 2: 30% off (scheduled)'
       ELSE NULL END AS markdown_step
FROM wk w CROSS JOIN tot t CROSS JOIN oh o;

-- po_lifecycle_v
CREATE OR REPLACE VIEW sset1000.supplychain.po_lifecycle_v AS
WITH lines AS (
  SELECT po_id, sum(qty_ordered) AS qty_ordered, sum(qty_received) AS qty_received, sum(qty_cancelled) AS qty_cancelled,
    round(sum((qty_ordered - qty_received - qty_cancelled) * unit_cost),2) AS open_value,
    round(sum(qty_ordered * unit_cost),2) AS po_value
  FROM sset1000.supplychain.po_line GROUP BY po_id
)
SELECT h.po_id, h.master_po_id, h.vendor_id, v.vendor_name, h.ship_to_store AS store_id,
  h.po_type, h.order_date, date_trunc('month', h.order_date) AS order_month,
  h.requested_ship, h.cancel_after, h.edi_855_ack, h.status,
  datediff(date'2026-07-14', h.order_date) AS age_days,
  CASE WHEN h.status='Open' AND h.requested_ship < date'2026-07-14' THEN true ELSE false END AS past_requested_ship,
  coalesce(l.qty_ordered,0) AS qty_ordered, coalesce(l.qty_received,0) AS qty_received,
  coalesce(l.qty_cancelled,0) AS qty_cancelled, coalesce(l.open_value,0) AS open_value, coalesce(l.po_value,0) AS po_value
FROM sset1000.supplychain.po_header h
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = h.vendor_id
LEFT JOIN lines l ON l.po_id = h.po_id
WHERE h.po_level='Store';

-- demand_timeline_v
CREATE OR REPLACE VIEW sset1000.supplychain.demand_timeline_v AS
SELECT f.forecast_week,
  date_trunc('week', date_sub(f.forecast_week, coalesce(lt.lead_days, 21))) AS order_by_week,
  date_sub(f.forecast_week, coalesce(lt.lead_days, 21)) AS order_by_date,
  b.store_id, s.store_name, s.climate_zone,
  b.category, b.subcategory, b.brand, b.vendor_id, v.vendor_name,
  coalesce(lt.lead_days, 21) AS lead_days_p50,
  round(sum(f.forecast_units),1) AS forecast_units,
  round(sum(f.weather_adj_units),1) AS weather_adj_units,
  round(sum(f.forecast_units * b.base_cost),0) AS forecast_cost,
  round(sum(f.forecast_units * b.base_retail),0) AS forecast_retail,
  round(sum(f.weather_adj_units * b.base_cost),0) AS weather_adj_cost,
  round(sum(f.weather_adj_units * b.base_retail),0) AS weather_adj_retail,
  CASE WHEN date_sub(f.forecast_week, coalesce(lt.lead_days,21)) >= date'2026-07-14' THEN true ELSE false END AS weather_reactable
FROM sset1000.supplychain.demand_forecast f
JOIN (SELECT DISTINCT store_id, sku_id, category, subcategory, brand, vendor_id, base_cost, base_retail FROM sset1000.supplychain.demand_base) b
  ON b.store_id = f.store_id AND b.sku_id = f.sku_id
JOIN sset1000.supplychain.dim_store s ON s.store_id = b.store_id
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = b.vendor_id
LEFT JOIN (SELECT vendor_id, max(actual_lead_days_p50) AS lead_days FROM sset1000.supplychain.vendor_lead_times GROUP BY 1) lt
  ON lt.vendor_id = b.vendor_id
GROUP BY f.forecast_week, b.store_id, s.store_name, s.climate_zone, b.category, b.subcategory, b.brand, b.vendor_id, v.vendor_name, lt.lead_days;

-- task_board_v
CREATE OR REPLACE VIEW sset1000.supplychain.task_board_v AS
SELECT t.task_id, t.store_id, s.store_name, t.task_type, t.related_event, t.title, t.due_date, t.status, t.completed_by,
  datediff(date'2026-07-14', t.due_date) AS days_past_due
FROM sset1000.supplychain.store_tasks t
JOIN sset1000.supplychain.dim_store s ON s.store_id = t.store_id;

-- kpi_summary_v
CREATE OR REPLACE VIEW sset1000.supplychain.kpi_summary_v AS
WITH inv AS (SELECT count(*) AS positions, sum(CASE WHEN on_hand=0 THEN 1 ELSE 0 END) AS outs,
             sum(on_hand*unit_cost) AS inv_cost FROM sset1000.supplychain.fact_inventory_daily WHERE snapshot_date=date'2026-07-13'),
meat AS (SELECT count(*) AS meat_outs FROM sset1000.supplychain.fact_inventory_daily f
         JOIN sset1000.supplychain.demand_base b ON b.store_id=f.store_id AND b.sku_id=f.sku_id
         JOIN sset1000.supplychain.dim_style st ON st.style_id=b.style_id
         JOIN sset1000.supplychain.size_curves sc ON sc.curve_id=st.size_curve_id AND sc.size=b.size
         WHERE f.snapshot_date=date'2026-07-13' AND f.on_hand=0 AND sc.meat_size),
sales AS (SELECT sum(cogs) AS cogs_1y, sum(net_sales) AS sales_1y, sum(margin_dollars) AS margin_1y FROM sset1000.supplychain.fact_sales_daily),
sales30 AS (SELECT sum(net_sales) AS sales_30d FROM sset1000.supplychain.fact_sales_daily WHERE sales_date >= date'2026-06-14'),
lost AS (SELECT round(sum(est_lost_sales),0) AS lost_sales FROM sset1000.supplychain.stockout_events WHERE start_date >= date'2026-06-14'),
md AS (SELECT sum(CASE WHEN promo_flag THEN units*0 ELSE 0 END) AS x, round(sum(CASE WHEN promo_flag THEN net_sales ELSE 0 END),0) AS promo_sales FROM sset1000.supplychain.fact_sales_daily),
twm AS (SELECT round(100*sum(CASE WHEN variance_type='None' THEN 1 ELSE 0 END)/count(*),1) AS auto_clear_pct,
        round(sum(CASE WHEN status IN ('PendingReview','DebitMemoSent') THEN variance_amount ELSE 0 END),0) AS open_exception_amt,
        sum(CASE WHEN status IN ('PendingReview','DebitMemoSent') THEN 1 ELSE 0 END) AS open_exceptions FROM sset1000.supplychain.threeway_match),
tsk AS (SELECT sum(CASE WHEN status IN ('Open','InProgress') THEN 1 ELSE 0 END) AS open_tasks,
        sum(CASE WHEN status='Overdue' THEN 1 ELSE 0 END) AS overdue_tasks FROM sset1000.supplychain.store_tasks),
rs AS (SELECT count(*) AS replen_suggestions, sum(CASE WHEN action='ExpediteCheck' THEN 1 ELSE 0 END) AS expedite_checks FROM sset1000.supplychain.replen_suggestions),
opp AS (SELECT count(*) AS open_deals, round(sum((base_unit_cost-offer_unit_cost)*commit_qty),0) AS open_deal_savings FROM sset1000.supplychain.vendor_promo_opportunities WHERE status='Open')
SELECT round(100.0*(inv.positions-inv.outs)/inv.positions,1) AS in_stock_pct,
  meat.meat_outs, inv.outs AS total_outs,
  round(sales.cogs_1y/inv.inv_cost,2) AS inventory_turns,
  round(100.0*sales.margin_1y/sales.sales_1y,1) AS margin_pct,
  sales30.sales_30d, lost.lost_sales AS est_lost_sales_30d,
  twm.auto_clear_pct, twm.open_exceptions, twm.open_exception_amt,
  tsk.open_tasks, tsk.overdue_tasks, rs.replen_suggestions, rs.expedite_checks,
  opp.open_deals, opp.open_deal_savings
FROM inv, meat, sales, sales30, lost, md, twm, tsk, rs, opp;

-- deal_pipeline_v
CREATE OR REPLACE VIEW sset1000.supplychain.deal_pipeline_v AS
SELECT o.opp_id, v.vendor_name, o.opp_type, o.description, o.offer_date, o.expiry_date,
  o.commit_qty, o.offer_unit_cost, o.base_unit_cost,
  round((o.base_unit_cost - o.offer_unit_cost) * o.commit_qty, 0) AS savings_at_commit,
  round(100*o.est_margin_uplift_pct,1) AS margin_uplift_pct, o.est_weeks_of_supply,
  o.ai_recommendation, o.status,
  datediff(o.expiry_date, date'2026-07-14') AS days_to_expiry
FROM sset1000.supplychain.vendor_promo_opportunities o
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = o.vendor_id;

-- statement_recon_v
CREATE OR REPLACE VIEW sset1000.supplychain.statement_recon_v AS
WITH exc AS (
  SELECT i.master_statement_id,
    sum(CASE WHEN m.status IN ('PendingReview','DebitMemoSent') THEN 1 ELSE 0 END) AS open_exceptions,
    round(sum(CASE WHEN m.status IN ('PendingReview','DebitMemoSent') THEN m.variance_amount ELSE 0 END),2) AS open_exception_amt,
    round(sum(CASE WHEN m.status IN ('Resolved') THEN m.variance_amount ELSE 0 END),2) AS resolved_amt
  FROM sset1000.supplychain.threeway_match m
  JOIN sset1000.supplychain.invoice_header i ON i.invoice_id = m.invoice_id
  GROUP BY 1
)
SELECT i.master_statement_id, v.vendor_name,
  count(*) AS invoice_count,
  round(sum(i.merch_amount),2) AS merch_amount,
  round(sum(i.freight_amount),2) AS freight_amount,
  round(sum(i.total_amount),2) AS statement_total,
  min(i.invoice_date) AS first_invoice, max(i.due_date) AS last_due,
  datediff(min(i.due_date), date'2026-07-14') AS days_to_first_due,
  coalesce(e.open_exceptions,0) AS open_exceptions,
  coalesce(e.open_exception_amt,0) AS open_exception_amt,
  coalesce(e.resolved_amt,0) AS resolved_amt,
  CASE WHEN coalesce(e.open_exceptions,0)=0 THEN 'Clear to pay'
       WHEN coalesce(e.open_exception_amt,0) > 500 THEN 'Hold - material exceptions'
       ELSE 'Pay less debit memos' END AS recon_status
FROM sset1000.supplychain.invoice_header i
JOIN sset1000.supplychain.dim_vendor v ON v.vendor_id = i.vendor_id
LEFT JOIN exc e ON e.master_statement_id = i.master_statement_id
GROUP BY i.master_statement_id, v.vendor_name, e.open_exceptions, e.open_exception_amt, e.resolved_amt;
