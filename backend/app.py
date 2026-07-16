"""WorkWorld Merchandise Planning & Operations — Databricks App backend.

FastAPI service that (1) serves the static SPA from ../frontend and
(2) exposes POST /api/query, a read-only SQL endpoint restricted to the
whitelisted views/tables in sset1000.supplychain.

Auth: when deployed as a Databricks App, the SDK Config picks up the app's
service principal automatically (OAuth M2M via injected env). Locally, set
DATABRICKS_HOST + DATABRICKS_TOKEN (or use a configured profile) and
DATABRICKS_WAREHOUSE_HTTP_PATH.
"""
import datetime
import decimal
import os
import re
from pathlib import Path

from databricks import sql as dbsql
from databricks.sdk.core import Config
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

SCHEMA = "sset1000.supplychain"

# The application data contract: views (the API) + 4 registry tables read directly.
ALLOWED_OBJECTS = {
    # views
    "kpi_summary_v", "sales_trend_v", "exception_queue_v", "size_run_health_v",
    "deal_pipeline_v", "replen_queue_v", "ats_coverage_v", "task_board_v",
    "forecast_summary_v", "store_variance_v", "lead_time_variance_v", "size_demand_v",
    "price_event_pipeline_v", "price_impact_v", "prebuy_analysis_v",
    "po_document_tree_v", "statement_recon_v", "match_trend_v", "po_lifecycle_v",
    "markdown_season_v", "markdown_ladder_v", "demand_timeline_v", "proposed_po_v",
    # registry tables the UI reads directly
    "markdown_policy", "experiments", "data_health", "dim_vendor",
}

FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|set)\b",
    re.IGNORECASE,
)
OBJECT_REF = re.compile(r"sset1000\.supplychain\.(\w+)", re.IGNORECASE)

app = FastAPI(title="ww-merch-ops")
_cfg = Config()  # Databricks App SP locally falls back to env/profile auth

# The `warehouse` app resource may inject either the bare warehouse id or the
# full HTTP path depending on platform version; accept both.
_wh = os.environ.get("DATABRICKS_WAREHOUSE_HTTP_PATH", "")
WAREHOUSE_HTTP_PATH = _wh if _wh.startswith("/") else (f"/sql/1.0/warehouses/{_wh}" if _wh else "")


class QueryRequest(BaseModel):
    sql: str


def _validate(sql: str) -> str:
    q = sql.strip().rstrip(";")
    if ";" in q:
        raise HTTPException(400, "Single statement only.")
    if not q.lower().startswith("select"):
        raise HTTPException(400, "SELECT statements only.")
    if FORBIDDEN.search(q):
        raise HTTPException(400, "Read-only endpoint.")
    refs = {m.group(1).lower() for m in OBJECT_REF.finditer(q)}
    if not refs:
        raise HTTPException(400, f"Queries must reference {SCHEMA} objects.")
    bad = refs - ALLOWED_OBJECTS
    if bad:
        raise HTTPException(403, f"Object(s) not in the app contract: {sorted(bad)}")
    return q


def _jsonable(v):
    if isinstance(v, bool):
        return "true" if v else "false"   # frontend compares string booleans
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return str(v)
    return v


@app.post("/api/query")
def query(req: QueryRequest):
    q = _validate(req.sql)
    if not WAREHOUSE_HTTP_PATH:
        raise HTTPException(500, "DATABRICKS_WAREHOUSE_HTTP_PATH is not configured.")
    with dbsql.connect(
        server_hostname=_cfg.host.replace("https://", ""),
        http_path=WAREHOUSE_HTTP_PATH,
        credentials_provider=lambda: _cfg.authenticate,
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(q)
            columns = [d[0] for d in cur.description]
            rows = [[_jsonable(v) for v in row] for row in cur.fetchmany(10000)]
    return {"columns": columns, "rows": rows}


@app.get("/healthz")
def healthz():
    return {"ok": True}


FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/styles.css")
def styles():
    return FileResponse(FRONTEND / "styles.css")


@app.get("/app.js")
def appjs():
    return FileResponse(FRONTEND / "app.js")
