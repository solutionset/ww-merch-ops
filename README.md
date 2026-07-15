# ww-merch-ops — WorkWorld Merchandise Planning & Operations

SolutionSet module for Gart Companies / WorkWorld (workwear retail: 38 stores,
direct-to-store, 80% replenishment / 20% seasonal). Ten functional modules over a
Databricks lakehouse: Command Center, Demand Planning, Replenishment, Vendor ATS,
Vendor Deals, PO & 3-Way Reconciliation, Pricing & Promotion, Markdown Management,
Team Comms, Data Health.

**Status: demo build.** All data in `sset1000.supplychain` is generated
(anchor date 2026-07-14) — see `sql/30_demo_data.md`.

## Architecture

```
frontend/   Static SPA (vanilla JS + Chart.js). Talks only to /api/query.
backend/    FastAPI. Serves the SPA + a whitelisted read-only SQL endpoint
            over the 24 views (+4 registry tables) in sset1000.supplychain.
sql/        The data contract: table DDL (10_) and view definitions (20_),
            exported live from Unity Catalog. Views ARE the API.
docs/       Project plan (docx) + support workbook (xlsx, data dictionary
            and module map).
app.yaml    Databricks Apps deployment config.
```

Design standards follow the SolutionSet NFP Forecast Module: navy top bar with
client/module/scenario/build tags, numbered module navigation, card layout on the
grid background, monospace code tags, corner-bracket focus treatment.

## Run locally

```bash
pip install -r backend/requirements.txt
export DATABRICKS_HOST=https://<workspace>.azuredatabricks.net
export DATABRICKS_TOKEN=<pat with SELECT on sset1000.supplychain>
export DATABRICKS_WAREHOUSE_HTTP_PATH=/sql/1.0/warehouses/<id>
uvicorn backend.app:app --reload
# open http://localhost:8000
```

## Deploy as a Databricks App

1. Create the app: `databricks apps create ww-merch-ops`
2. In app settings, add a **SQL warehouse resource named `warehouse`**
   (serverless recommended) — `app.yaml` maps it to
   `DATABRICKS_WAREHOUSE_HTTP_PATH`.
3. Grant the app's service principal **USE CATALOG on sset1000, USE SCHEMA +
   SELECT on sset1000.supplychain** (views + the 4 registry tables are enough).
4. `databricks apps deploy ww-merch-ops --source-code-path /Workspace/.../ww-merch-ops`

## Security model

- The backend enforces: single statement, SELECT-only, keyword denylist, and an
  object whitelist (`backend/app.py: ALLOWED_OBJECTS`). The frontend never
  receives credentials; the SP never has write grants.
- Hardening backlog: replace free-SQL-over-whitelist with named, parameterized
  endpoints per view; add response caching; per-user auth passthrough if/when
  client users get direct access.

## Provenance

- `frontend/_source_artifact.html` is the original Cowork artifact (v0-0006);
  `split_frontend.py` performs the artifact → SPA transform (runQ swaps from the
  Cowork MCP bridge to `/api/query`). Kept for diffability during the transition.
- Demo data caveats and the regeneration plan: `sql/30_demo_data.md`.

## Roadmap

- [ ] Commit demo-data generator SQL (`sql/31_generate_demo_data.sql`)
- [ ] Split `app.js` into per-module files (`js/modules/*.js`)
- [ ] Replace demo anchor `date'2026-07-14'` with `current_date()` in views
- [ ] Dampen inventory generator so turns read ~2.5–3
- [ ] Named API endpoints; retire free-SQL whitelist
- [ ] Client catalog migration plan (`sset1000` → client catalog) per proposal
