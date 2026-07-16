# Demo data — provenance & regeneration

All rows in `sset1000.supplychain` are **generated demo data** (anchor date **2026-07-14**),
built from WorkWorld's real brands and geography. Nothing is client data.

Generation is **deterministic**: every random draw is `pmod(abs(hash(keys...)), N)`,
so re-running the generators reproduces the identical dataset.

| Layer | How it was built |
|---|---|
| Reference dims (stores, vendors, terms, categories, styles, curves, tags, policies) | `CREATE TABLE ... AS SELECT * FROM VALUES ...` (authored rows) |
| `dim_sku` | Style × color × size explosion driven by category size model |
| `demand_base` | Helper: expected daily rate per store × SKU = category rate × size-curve share × store size factor |
| `weather_daily` | Zone × day, seasonal rain probabilities (Puget wet winters), 10-day forecast tail |
| `fact_sales_daily` | 365 days × demand_base, shaped by seasonality curves, weekday factors, rain lift; hash-seeded unit draws |
| `fact_inventory_daily` | 60 daily snapshots; ~4% stockout injection; projected stockout from burn rate |
| PO chain (`po_header/line`, `receiver_*`, `invoice_*`) | Monthly master POs per vendor → child store POs → receipts at observed lead ± jitter (92% fill, short-ships) → invoices with price-variance (4%) and freight (12%) injections |
| `threeway_match` | Computed join of the three legs with root-cause classification |
| Planning outputs (`demand_forecast`, `replen_suggestions`, `stockout_events`, `transfer_orders`) | Computed from demand_base + latest inventory |
| Ops rows (`price_change_events`, `store_tasks`, `comms_log`, `experiments`, `vendor_ats`) | Authored + generated per store/event |

The full generator SQL was executed statement-by-statement during the initial build
(2026-07-14/15 Cowork session). **TODO (next commit):** commit the generators as
`31_generate_demo_data.sql` so the schema is rebuildable from a clean catalog.
Until then, `10_tables_ddl.sql` + `20_views.sql` reproduce structure and contract,
and the populated schema lives in `sset1000.supplychain`.

Known demo caveats (also flagged in the app):
- Inventory turns compute high (~5.4) vs workwear reality (2–3); dampen the
  inventory generator before client-facing demos.
- Seasonal (non-replenishable) SKUs have no inventory snapshots; `markdown_season_v`
  estimates season supply at 125% of season sales.
- `prebuy_analysis_v` hardcodes announced increase percentages for events that
  exist only as announcements (PC-503, PC-506).
- Several views pin `date'2026-07-14'` as "today"; production swaps to `current_date()`.
