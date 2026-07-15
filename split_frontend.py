#!/usr/bin/env python3
"""One-time transform: split the Cowork artifact (frontend/_source_artifact.html)
into index.html / styles.css / app.js, swapping the Cowork MCP bridge (runQ)
for the backend fetch adapter. Kept in-repo for provenance; safe to re-run."""
import re
from pathlib import Path

root = Path(__file__).resolve().parent / "frontend"
src = (root / "_source_artifact.html").read_text(encoding="utf-8")

# 1) extract CSS
m = re.search(r"<style>\n(.*?)</style>", src, re.S)
css = m.group(1)
(root / "styles.css").write_text(css, encoding="utf-8")

# 2) extract app JS (the last <script> block, which starts with const TOOL=)
m2 = re.search(r"<script>\n(const TOOL=.*?)</script>\n</body>", src, re.S)
js = m2.group(1)

OLD_RUNQ = re.search(r"const TOOL=.*?return arr\.map\(row=>Object\.fromEntries\(row\.values\.map\(\(v,i\)=>\[cols\[i\], v\.string_value \?\? v\.str \?\? null\]\)\)\);\n\}", js, re.S).group(0)
NEW_RUNQ = """const S='sset1000.supplychain';
// Data adapter: in Cowork this called the MCP bridge; deployed, it calls the
// backend's whitelisted read-only endpoint (see backend/app.py).
async function runQ(sql){
  const r=await fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql})});
  if(!r.ok) throw new Error('Query failed: '+await r.text());
  const p=await r.json();
  return p.rows.map(row=>Object.fromEntries(p.columns.map((c,i)=>[c, row[i]==null?null:String(row[i])])));
}"""
js = js.replace(OLD_RUNQ, NEW_RUNQ)
assert "callMcpTool" not in js, "MCP bridge references remain"
(root / "app.js").write_text(js, encoding="utf-8")

# 3) index.html: link the split assets
html = src.replace("<style>\n" + css + "</style>", '<link rel="stylesheet" href="styles.css">')
html = html.replace("<script>\n" + m2.group(1) + "</script>\n</body>", '<script src="app.js" defer></script>\n</body>')
(root / "index.html").write_text(html, encoding="utf-8")
print("split ok:", {p.name: (root / p.name).stat().st_size for p in [Path("index.html"), Path("styles.css"), Path("app.js")]})
