-- WorkWorld Merchandise Planning & Operations — base table DDL
-- Exported from sset1000.information_schema (live schema state, 2026-07-15).
-- NOTE: table COMMENTs and demo-data generation are documented in 30_demo_data.md.
-- Demo anchor date: 2026-07-14. All data is generated/illustrative.

CREATE SCHEMA IF NOT EXISTS sset1000.supplychain
  COMMENT 'WorkWorld Merchandise Planning & Operations module (demo build). Base tables + _v views consumed by the app. Demo anchor date 2026-07-14.';

-- demand_forecast
CREATE TABLE IF NOT EXISTS sset1000.supplychain.demand_forecast (
  forecast_units decimal(22,2),
  weather_adj_units decimal(24,2),
  model_version string,
  mape_trailing_8wk decimal(15,2),
  forecast_week date,
  store_id string,
  sku_id string
);

-- invoice_line
CREATE TABLE IF NOT EXISTS sset1000.supplychain.invoice_line (
  invoice_id string,
  line_no int,
  sku_id string,
  qty_invoiced int,
  unit_cost decimal(8,2),
  ext_amount decimal(20,2)
);

-- invoice_header
CREATE TABLE IF NOT EXISTS sset1000.supplychain.invoice_header (
  invoice_id string,
  vendor_id string,
  master_statement_id string,
  po_id string,
  invoice_date date,
  due_date date,
  merch_amount decimal(30,2),
  freight_amount decimal(11,1),
  other_charges decimal(1,1),
  total_amount decimal(32,2)
);

-- replen_suggestions
CREATE TABLE IF NOT EXISTS sset1000.supplychain.replen_suggestions (
  suggestion_id string,
  created_date date,
  store_id string,
  sku_id string,
  action string,
  suggested_qty int,
  proj_stockout_date date,
  reason string,
  tier_break_note string,
  status string
);

-- store_traffic_daily
CREATE TABLE IF NOT EXISTS sset1000.supplychain.store_traffic_daily (
  conversion_pct decimal(27,4),
  traffic_date date,
  store_id string,
  door_count int,
  transactions int
);

-- weather_daily
CREATE TABLE IF NOT EXISTS sset1000.supplychain.weather_daily (
  weather_date date,
  climate_zone string,
  precip_in decimal(17,2),
  temp_high_f int,
  temp_low_f int,
  rain_event_flag boolean,
  record_type string
);

-- vendor_tier_pricing
CREATE TABLE IF NOT EXISTS sset1000.supplychain.vendor_tier_pricing (
  tier_id string,
  vendor_id string,
  program string,
  uom string,
  tier_min_qty int,
  tier_max_qty int,
  unit_price decimal(4,2),
  disc_vs_base_pct decimal(2,2),
  effective_start date,
  effective_end date
);

-- vendor_terms
CREATE TABLE IF NOT EXISTS sset1000.supplychain.vendor_terms (
  disc_days int,
  freight_terms string,
  fob_point string,
  min_prepaid_freight decimal(5,1),
  vendor_id string,
  terms_code string,
  net_days int,
  disc_pct decimal(2,2)
);

-- demand_base (demo helper: generation-only)
CREATE TABLE IF NOT EXISTS sset1000.supplychain.demand_base (
  sku_id string,
  style_id string,
  size string,
  color string,
  replenishable boolean,
  vendor_id string,
  brand string,
  style_name string,
  category_id string,
  seasonality_id string,
  base_cost decimal(5,2),
  base_retail decimal(5,2),
  lifecycle string,
  category string,
  subcategory string,
  weather_sensitivity string,
  rain_lift decimal(2,1),
  base_daily_units decimal(19,4),
  store_id string,
  climate_zone string,
  sqft int
);

-- dim_vendor
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_vendor (
  vendor_id string,
  vendor_name string,
  parent_vendor string,
  sophistication string,
  edi_via_sps boolean,
  edi_docs string,
  ats_method string,
  rep_name string,
  rep_email string,
  status string
);

-- dim_style
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_style (
  vendor_id string,
  brand string,
  style_name string,
  category_id string,
  lifecycle string,
  season_code string,
  size_curve_id string,
  seasonality_id string,
  base_cost decimal(5,2),
  base_retail decimal(5,2),
  colors array<string>,
  style_id string
);

-- markdown_policy
CREATE TABLE IF NOT EXISTS sset1000.supplychain.markdown_policy (
  policy_id string,
  scope string,
  trigger string,
  step_1 string,
  step_2 string,
  step_3 string,
  floor_margin_pct decimal(2,2),
  status string
);

-- po_line
CREATE TABLE IF NOT EXISTS sset1000.supplychain.po_line (
  po_id string,
  line_no int,
  sku_id string,
  qty_ordered int,
  unit_cost decimal(5,2),
  qty_received int,
  qty_cancelled int
);

-- price_change_events
CREATE TABLE IF NOT EXISTS sset1000.supplychain.price_change_events (
  event_id string,
  event_type string,
  vendor_id string,
  scope string,
  skus_affected int,
  effective_date date,
  erp_updated boolean,
  stores_notified boolean,
  label_file_generated boolean,
  comm_id string
);

-- receiver_line
CREATE TABLE IF NOT EXISTS sset1000.supplychain.receiver_line (
  receiver_id string,
  line_no int,
  sku_id string,
  qty_expected int,
  qty_received int,
  qty_damaged int,
  variance_units int,
  note string
);

-- receiver_header
CREATE TABLE IF NOT EXISTS sset1000.supplychain.receiver_header (
  receiver_id string,
  po_id string,
  store_id string,
  received_date date,
  asn_856_matched boolean,
  carton_count int,
  received_by string,
  status string
);

-- store_sku_params
CREATE TABLE IF NOT EXISTS sset1000.supplychain.store_sku_params (
  sku_id string,
  min_units int,
  max_units int,
  reorder_point int,
  safety_stock int,
  lead_time_days_override int,
  last_reviewed date,
  review_source string,
  store_id string
);

-- store_tasks
CREATE TABLE IF NOT EXISTS sset1000.supplychain.store_tasks (
  task_id string,
  store_id string,
  task_type string,
  related_event string,
  title string,
  due_date date,
  status string,
  completed_by string,
  completed_at date
);

-- vendor_lead_times
CREATE TABLE IF NOT EXISTS sset1000.supplychain.vendor_lead_times (
  actual_lead_days_p90 int,
  fill_rate_pct decimal(2,2),
  moq_units int,
  review_date date,
  vendor_id string,
  category string,
  quoted_lead_days int,
  actual_lead_days_p50 int
);

-- vendor_promo_opportunities
CREATE TABLE IF NOT EXISTS sset1000.supplychain.vendor_promo_opportunities (
  opp_id string,
  vendor_id string,
  opp_type string,
  description string,
  offer_date date,
  expiry_date date,
  commit_qty int,
  offer_unit_cost decimal(4,2),
  base_unit_cost decimal(5,2),
  est_margin_uplift_pct decimal(3,3),
  est_weeks_of_supply decimal(3,1),
  ai_recommendation string,
  status string
);

-- data_health
CREATE TABLE IF NOT EXISTS sset1000.supplychain.data_health (
  refresh_cadence string,
  owner string,
  last_load_at timestamp,
  table_name string,
  source string,
  manually_managed boolean
);

-- dim_store
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_store (
  store_id string,
  store_name string,
  store_type string,
  banner string,
  city string,
  state string,
  climate_zone string,
  traffic_counter boolean,
  sqft int,
  open_date date,
  status string,
  latitude double,
  longitude double
);

-- dim_sku
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_sku (
  sku_id string,
  style_id string,
  color string,
  size string,
  upc string,
  replenishable boolean,
  status string
);

-- fact_sales_daily
CREATE TABLE IF NOT EXISTS sset1000.supplychain.fact_sales_daily (
  sales_date date,
  store_id string,
  sku_id string,
  units int,
  promo_flag boolean,
  net_sales decimal(19,2),
  cogs decimal(17,2),
  margin_dollars decimal(20,2),
  weather_rain_flag boolean
);

-- fact_inventory_daily
CREATE TABLE IF NOT EXISTS sset1000.supplychain.fact_inventory_daily (
  snapshot_date date,
  store_id string,
  sku_id string,
  on_hand int,
  on_order int,
  in_transit int,
  unit_cost decimal(5,2),
  proj_stockout_date date
);

-- experiments
CREATE TABLE IF NOT EXISTS sset1000.supplychain.experiments (
  primary_metric string,
  result string,
  ai_summary string,
  decision string,
  exp_id string,
  hypothesis string,
  scope string,
  start_date date,
  end_date date
);

-- po_header
CREATE TABLE IF NOT EXISTS sset1000.supplychain.po_header (
  vendor_id string,
  ship_to_store string,
  po_type string,
  order_date date,
  requested_ship date,
  cancel_after date,
  edi_850_sent boolean,
  edi_855_ack string,
  status string,
  po_id string,
  master_po_id string,
  po_level string
);

-- stockout_events
CREATE TABLE IF NOT EXISTS sset1000.supplychain.stockout_events (
  event_id string,
  store_id string,
  sku_id string,
  start_date date,
  end_date date,
  days_out bigint,
  est_lost_units decimal(36,1),
  est_lost_sales decimal(35,2),
  meat_size_flag boolean,
  root_cause string
);

-- vendor_ats
CREATE TABLE IF NOT EXISTS sset1000.supplychain.vendor_ats (
  snapshot_date date,
  vendor_id string,
  vendor_sku string,
  sku_id string,
  ats_units int,
  vendor_dc string,
  next_avail_date date,
  capture_method string
);

-- transfer_orders
CREATE TABLE IF NOT EXISTS sset1000.supplychain.transfer_orders (
  transfer_id string,
  from_store string,
  to_store string,
  sku_id string,
  qty int,
  reason string,
  trigger string,
  created_date date,
  status string
);

-- comms_log
CREATE TABLE IF NOT EXISTS sset1000.supplychain.comms_log (
  comm_id string,
  audience string,
  channel string,
  subject string,
  drafted_by string,
  approved_by string,
  sent_at date,
  related_event string
);

-- dim_category
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_category (
  category_id string,
  department string,
  category string,
  subcategory string,
  lifecycle string,
  size_model string,
  default_size_curve string,
  default_seasonality string,
  weather_sensitivity string,
  base_daily_rate decimal(2,2)
);

-- dim_calendar
CREATE TABLE IF NOT EXISTS sset1000.supplychain.dim_calendar (
  calendar_date date,
  cal_year int,
  cal_month int,
  month_abbr string,
  iso_week int,
  day_of_week int,
  day_abbr string,
  is_weekend boolean,
  retail_period string
);

-- item_crossref
CREATE TABLE IF NOT EXISTS sset1000.supplychain.item_crossref (
  sku_id string,
  vendor_id string,
  vendor_style string,
  vendor_sku string,
  upc string,
  source string
);

-- product_tags
CREATE TABLE IF NOT EXISTS sset1000.supplychain.product_tags (
  tag_id string,
  entity_type string,
  entity_id string,
  tag_type string,
  tag_value string,
  strength decimal(2,1),
  source string
);

-- price_master
CREATE TABLE IF NOT EXISTS sset1000.supplychain.price_master (
  sku_id string,
  effective_date date,
  unit_cost decimal(8,2),
  retail_price decimal(9,2),
  price_type string,
  source string
);

-- size_curves
CREATE TABLE IF NOT EXISTS sset1000.supplychain.size_curves (
  curve_id string,
  curve_name string,
  size string,
  pct_units decimal(3,2),
  meat_size boolean
);

-- seasonality_curves
CREATE TABLE IF NOT EXISTS sset1000.supplychain.seasonality_curves (
  curve_id string,
  curve_name string,
  month_num int,
  month_abbr string,
  demand_index decimal(3,2)
);

-- threeway_match
CREATE TABLE IF NOT EXISTS sset1000.supplychain.threeway_match (
  match_id string,
  po_id string,
  receiver_id string,
  invoice_id string,
  sku_id string,
  vendor_id string,
  invoice_date date,
  qty_po int,
  qty_received int,
  qty_invoiced int,
  cost_po decimal(5,2),
  cost_invoiced decimal(8,2),
  variance_type string,
  variance_amount decimal(22,2),
  ai_suggested_resolution string,
  status string
);
