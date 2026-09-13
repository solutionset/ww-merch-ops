// ---------------- data adapter: Databricks App backend ----------------
// In Cowork this file called the MCP bridge. In the deployed app all SQL goes through
// the FastAPI backend, which authenticates as the app service principal and enforces
// SELECT-only plus the object allowlist server-side.
const S='sset1000.supplychain';
const ANCHOR='2026-07-14';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function apiPost(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let p=null;
  try{ p=await r.json(); }catch(e){ throw new Error('Bad response from '+path+' ('+r.status+')'); }
  if(!r.ok) throw new Error((p&&(p.detail||p.error||p.message))||('Request failed ('+r.status+')'));
  return p;
}
// Tolerates either a raw Databricks statement payload (manifest/result) or a
// simplified {columns, rows} / {data:[...]} shape, so this survives a backend refactor.
function normalizeRows(p){
  if(!p) return [];
  if(Array.isArray(p)) return p;
  if(p.manifest&&p.result){
    const cols=p.manifest.schema.columns.map(c=>c.name);
    const arr=p.result.data_array||p.result.data_typed_array||[];
    return arr.map(row=>Object.fromEntries(row.values.map((v,i)=>[cols[i], v.string_value ?? v.str ?? null])));
  }
  if(p.columns&&Array.isArray(p.rows)){
    const cols=p.columns.map(c=>typeof c==='string'?c:(c.name||c.column_name));
    return p.rows.map(row=>Array.isArray(row)
      ? Object.fromEntries(cols.map((c,i)=>[c,row[i]]))
      : row);
  }
  if(Array.isArray(p.data)) return p.data;
  if(Array.isArray(p.result)) return p.result;
  return [];
}
// Every renderer below was written against string cell values (what the MCP bridge
// returned). Keep that contract so no page logic has to change.
async function runQ(sql){
  const p=await apiPost('/api/query',{sql});
  return normalizeRows(p).map(r=>{
    const o={}; Object.keys(r).forEach(k=>{ o[k]=r[k]==null?null:String(r[k]); }); return o;
  });
}
// Ask SolutionSet: askClaude() only exists inside Cowork.
// /api/ask proxies to a Databricks Model Serving endpoint (see backend/ask_endpoint.py).
async function askLLM(prompt){
  const p=await apiPost('/api/ask',{prompt:prompt});
  if(typeof p==='string') return p;
  return p.text ?? p.completion ?? p.content ?? p.answer ?? JSON.stringify(p);
}
const fmt$=x=>x==null?'—':'$'+Number(x).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtN=x=>x==null?'—':Number(x).toLocaleString('en-US',{maximumFractionDigits:0});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uniq=a=>[...new Set(a)].filter(x=>x!=null&&x!=='');
const SIZE_ORDER=['XS','S','M','L','XL','2XL','3XL','OS'];
function sizeSort(a,b){
  const ia=SIZE_ORDER.indexOf(a), ib=SIZE_ORDER.indexOf(b);
  if(ia>=0&&ib>=0) return ia-ib;
  if(ia>=0) return -1; if(ib>=0) return 1;
  const na=parseFloat(a), nb=parseFloat(b);
  if(!isNaN(na)&&!isNaN(nb)&&!a.includes('x')&&!b.includes('x')) return na-nb;
  return String(a).localeCompare(String(b),undefined,{numeric:true});
}
// ---------------- navigation model ----------------
const SECTIONS=[
 {id:'overview', label:'Overview',
  note:'Cross-application summary. Each sub-page rolls up the section it names — click through for the working detail.',
  subs:[{id:'ov-exec',label:'Executive summary'},{id:'ov-inv',label:'Inventory & service'},
        {id:'ov-margin',label:'Margin & pricing'},{id:'ov-ops',label:'Operations & vendors'}]},
 {id:'planning', label:'Planning & Purchasing',
  note:'Forecast → weather window you can still act on → order timing → proposed POs, then replenishment against observed lead times.',
  subs:[{id:'demand',label:'Demand Planning'},{id:'wxopp',label:'Weather opportunities'},{id:'replen',label:'Replenishment'},{id:'pogen',label:'PO Generator', under:'replen'}]},
 {id:'operations', label:'Operations',
  note:'The engine matches PO → receiver → invoice nightly. Analysis explains the close; Exception triage is the bulk queue that writes NetSuite.',
  subs:[{id:'match',label:'3-Way Match analysis'},{id:'matchq',label:'Exception triage', under:'match'}]},
 {id:'pricingmd', label:'Pricing & Markdowns',
  note:'Vendor price files and markdown ladders, each carrying its forecast margin impact to finance.',
  subs:[{id:'pricing',label:'Pricing & Promotion'},{id:'markdown',label:'Markdown Management'}]},
 {id:'vendor', label:'Vendor Management',
  note:'Phase 2 scope: vendor availability-to-sell capture and opportunity-buy evaluation.',
  subs:[{id:'ats',label:'Vendor availability (ATS)'},{id:'deals',label:'Vendor programs & deals'}]},
 {id:'ask', label:'Ask SolutionSet',
  note:'Natural-language analyst over the governed layer. Every answer shows the SQL it ran.',
  subs:[{id:'ask',label:'Ask SolutionSet'}]},
 {id:'comms', label:'Communications',
  note:'Condition → event → typed communication, with store task tracking and overdue escalation.',
  subs:[{id:'comms',label:'Team Comms & tasks'}]},
 {id:'admin', label:'Admin',
  note:'Feed freshness and stewardship of the tables merchandising owns by hand.',
  subs:[{id:'admin',label:'Data health'},{id:'refedit',label:'Reference tables'}]},
];
const PANELS=[]; SECTIONS.forEach(s=>s.subs.forEach(x=>PANELS.push({id:x.id,label:x.label,sec:s.id})));
const secOf=id=>(PANELS.find(p=>p.id===id)||{}).sec;
let curSec='overview', curPanel='ov-exec';
const loaded={}; const charts={};
function nav(){
  document.getElementById('tabs').innerHTML=SECTIONS.map(s=>
    `<button data-s="${s.id}" class="${s.id===curSec?'active':''}">${s.label}</button>`).join('');
  document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{
    const s=SECTIONS.find(x=>x.id===b.dataset.s); show(s.subs[0].id);
  });
  sidenav();
}
function sidenav(){
  const s=SECTIONS.find(x=>x.id===curSec);
  document.getElementById('side-title').textContent=s.label;
  document.getElementById('side-note').textContent=s.note;
  document.getElementById('sidenav').innerHTML=s.subs.map(x=>
    `<button data-p="${x.id}" class="${x.id===curPanel?'active':''}${x.under?' nest':''}">${x.label}</button>`).join('');
  document.querySelectorAll('#sidenav button').forEach(b=>b.onclick=()=>show(b.dataset.p));
}
function show(id){
  curPanel=id; curSec=secOf(id);
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active',b.dataset.s===curSec));
  sidenav();
  document.querySelectorAll('.module').forEach(d=>d.style.display=d.id==='mod-'+id?'':'none');
  window.scrollTo({top:0,behavior:'smooth'});
  if(!loaded[id]){loaded[id]=true; LOADERS[id]&&LOADERS[id]().catch(e=>{
    const el=document.querySelector('#mod-'+id+' .autoload'); if(el) el.innerHTML='<div class="err">'+esc(e.message)+'</div>'; console.error(e);
  });}
}
function header(m,title,sub){
  return `<h1>${title}</h1><div class="subtitle">${sub}</div>`;
}
function table(rows, cols){
  if(!rows.length) return '<div class="loading">No rows.</div>';
  const head=cols.map(c=>`<th>${c.h}</th>`).join('');
  const body=rows.map(r=>'<tr>'+cols.map(c=>`<td class="${c.num?'num':''}">${c.f?c.f(r):esc(r[c.k])}</td>`).join('')+'</tr>').join('');
  return `<div class="tblwrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function statusChip(s){
  const map={'PendingReview':'orange','DebitMemoSent':'blue','Resolved':'green','AutoCleared':'green','Open':'gray','Accepted':'green','Declined':'red','Suggested':'gray','Approved':'blue','InTransit':'purple','Received':'green','Done':'green','Overdue':'red','InProgress':'blue','MeatBreak':'red','FringeBreak':'orange','Intact':'green','Order':'blue','TransferFirst':'purple','ExpediteCheck':'red','Hold':'gray','Late 7+':'red','Late':'orange','On time':'green','Early':'blue','Proposed':'gray','Delay':'orange','Review':'purple','Assigned':'blue','Exported':'green','Clear':'green','Debit':'blue','Posted':'green','PriceVariance':'orange','QtyShort':'red','Freight':'purple','CostVariance':'orange','Transfer':'purple','Expedite':'red','Event buy':'blue','Watch':'gray','Too late':'red'};
  return `<span class="chip ${map[s]||'gray'}">${esc(s)}</span>`;
}
function build(){
  const main=document.getElementById('main');
  main.innerHTML=PANELS.map(p=>`<div class="module" id="mod-${p.id}" style="${p.id===curPanel?'':'display:none'}">${SHELLS[p.id](p)}</div>`).join('');
}
// ---------------- sparkline ----------------
function spark(vals,color){
  const W=160,H=34,pad=3;
  const v=vals.filter(x=>isFinite(x));
  if(v.length<2) return '<div style="height:34px"></div>';
  const mn=Math.min(...v), mx=Math.max(...v), rng=(mx-mn)||1;
  const pts=v.map((x,i)=>[pad+i*(W-2*pad)/(v.length-1), H-pad-((x-mn)/rng)*(H-2*pad)]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area=d+` L${pts[pts.length-1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  const last=pts[pts.length-1];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="overflow:visible">
    <path d="${area}" fill="${color}" fill-opacity=".13"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <line x1="${last[0].toFixed(1)}" y1="${(last[1]-3.2).toFixed(1)}" x2="${last[0].toFixed(1)}" y2="${(last[1]+3.2).toFixed(1)}"
      stroke="${color}" stroke-width="2.4" vector-effect="non-scaling-stroke"/></svg>`;
}
function sparkKPI(o){
  const d=o.deltaPct;
  const cls=d==null?'flat':(o.inverse? (d<0?'up':d>0?'dn':'flat') : (d>0?'up':d<0?'dn':'flat'));
  const arrow=d==null?'':(d>0?'▲':d<0?'▼':'■');
  const dtxt=d==null?'no prior period':`${arrow} ${Math.abs(d).toFixed(1)}% vs prior ${o.periodLabel}`;
  return `<div class="kpi">
    <div class="lbl">${o.label}</div>
    <div class="val">${o.value}</div>
    <div class="delta ${cls}">${dtxt}</div>
    <div class="spkwrap">${spark(o.series,o.color||'#2E5BFF')}</div>
    <div class="spkaxis"><span>${o.axisL}</span><span class="mid">${o.axisM}</span><span>${o.axisR}</span></div>
  </div>`;
}
// ---------------- shared chart helper ----------------
function mkChart(id,type,data,extra){
  const el=document.getElementById(id); if(!el) return;
  if(charts[id]) charts[id].destroy();
  charts[id]=new Chart(el,{type,data,options:Object.assign({responsive:true,maintainAspectRatio:false,
    plugins:Object.assign({legend:{labels:{boxWidth:12,font:{size:11}}}},(extra&&extra.plugins)||{}),
    scales:(extra&&extra.scales)||undefined,
    indexAxis:(extra&&extra.indexAxis)||undefined,
    onClick:(extra&&extra.onClick)||undefined},{})});
}
// ---------------- map ----------------
const STATE_SHAPES={
 CA:[[42,-124.4],[42,-120],[39,-120],[35,-114.63],[34.3,-114.13],[32.7,-114.5],[32.53,-117.13],[33.7,-118.3],[34.45,-120.65],[36.3,-121.9],[37.8,-122.5],[39.8,-123.8],[41,-124.15]],
 NV:[[42,-120],[42,-114.04],[37,-114.04],[35,-114.63],[39,-120]],
 OR:[[46.25,-124.05],[46.2,-116.95],[42,-117.02],[42,-124.4]],
 WA:[[49,-123.2],[49,-117.03],[46.2,-116.95],[46.25,-124.05],[47.35,-124.7],[48.35,-124.7],[48.25,-123.1]],
};
function proj(lat,lon){ const x=(lon+125.2)*46, y=(49.6-lat)*40; return [x,y]; }
function mapSVG(stores, metric, valueOf, selected){
  const vals=stores.map(valueOf);
  const maxAbs=Math.max(...vals.map(v=>Math.abs(v)),0.001);
  const shapes=Object.entries(STATE_SHAPES).map(([st,pts])=>{
    const d=pts.map((p,i)=>(i?'L':'M')+proj(p[0],p[1]).map(v=>v.toFixed(1)).join(',')).join(' ')+' Z';
    return `<path d="${d}" fill="#EDF3FC" stroke="#C9D6EC" stroke-width="1.2"/>`;
  }).join('');
  const dots=stores.map((s,i)=>{
    const [x,y]=proj(+s.latitude,+s.longitude);
    const v=vals[i];
    const r=4+16*Math.sqrt(Math.abs(v)/maxAbs);
    const col = metric==='var' ? (v<0?'#C0392B':'#1E9E5A') : (v>0?'#C0392B':'#9fb0cc');
    return `<circle class="store ${selected===s.store_id?'sel':''}" data-i="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity="0.55" stroke="${col}" stroke-width="1.5"/>
      <text x="${(x+r+3).toFixed(1)}" y="${(y+3).toFixed(1)}" font-size="9.5" fill="#5a6880">${s.store_id}</text>`;
  }).join('');
  return `<svg viewBox="0 30 520 560" width="100%" height="480" xmlns="http://www.w3.org/2000/svg">${shapes}${dots}</svg>`;
}
// generic bubble map that colours on a good/bad direction rather than the fixed variance rule
function mapSVG2(stores, valueOf, mode, selected){
  const vals=stores.map(valueOf);
  const maxAbs=Math.max(...vals.map(v=>Math.abs(v)),0.001);
  const shapes=Object.entries(STATE_SHAPES).map(([st,pts])=>{
    const d=pts.map((p,i)=>(i?'L':'M')+proj(p[0],p[1]).map(v=>v.toFixed(1)).join(',')).join(' ')+' Z';
    return `<path d="${d}" fill="#EDF3FC" stroke="#C9D6EC" stroke-width="1.2"/>`;
  }).join('');
  const colOf=v=> mode==='signed' ? (v<0?'#C0392B':'#1E9E5A') : mode==='bad' ? (v>0?'#C0392B':'#9fb0cc') : '#2E5BFF';
  const dots=stores.map((s,i)=>{
    const [x,y]=proj(+s.latitude,+s.longitude);
    const v=vals[i], col=colOf(v);
    const r=4+17*Math.sqrt(Math.abs(v)/maxAbs);
    return `<circle class="store ${selected===s.store_id?'sel':''}" data-i="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity="0.55" stroke="${col}" stroke-width="1.5"/>
      <text x="${(x+r+3).toFixed(1)}" y="${(y+3).toFixed(1)}" font-size="9.5" fill="#5a6880">${s.store_id}</text>`;
  }).join('');
  return `<svg viewBox="0 30 520 560" width="100%" height="470" xmlns="http://www.w3.org/2000/svg">${shapes}${dots}</svg>`;
}

const SHELLS={
'ov-exec':m=>header(m,'Executive summary','One page for the merchandising leadership meeting — trailing performance with prior-period comparison, and the whole network on one map you can re-point at any metric.')+`
  <div class="kpis spark autoload" id="ov-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="card focus">
    <h3>Network performance map — pick your metric</h3>
    <div class="hint">Every store, sized by the metric you choose and filtered to the category, brand or size you care about. Green/red shows direction where direction has meaning; click a store to break it down. This is the same engine the Replenishment page uses — pointed at whatever question is on the table.</div>
    <div class="controls" id="ov-map-controls"></div>
    <div class="row37">
      <div style="position:relative"><div id="ovmap"><div class="loading">{ LOADING }</div></div><div class="maptip" id="ovmaptip"></div></div>
      <div id="ov-map-side"><div class="loading">{ SELECT A STORE }</div></div>
    </div>
    <div class="legend" id="ov-map-legend"></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Sales &amp; margin — trailing 52 weeks</h3><div class="hint">Net sales with gross margin dollars overlaid. Promo share shows how much of the top line is being bought with price.</div><div class="chartbox"><canvas id="ch-ov-trend"></canvas></div></div>
    <div class="card"><h3>Where the attention goes this week</h3><div class="hint">Open items across every section of the application, largest first.</div><div id="ov-attn"><div class="loading">{ LOADING }</div></div></div>
  </div>`,
'ov-inv':m=>header(m,'Inventory &amp; service — summary','Rolls up Planning &amp; Purchasing: are we in stock on the sizes that matter, and is the replenishment queue keeping up?')+`
  <div class="kpis autoload" id="ovi-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="row2">
    <div class="card"><h3>Size-run health by store</h3><div class="hint">Meat-size breaks are the ones that cost a sale. Detail lives in Planning &amp; Purchasing → Replenishment.</div><div class="chartbox"><canvas id="ch-ovi-runs"></canvas></div></div>
    <div class="card"><h3>Replenishment queue by action</h3><div class="hint">Transfer-first suggestions avoid a purchase entirely.</div><div class="chartbox"><canvas id="ch-ovi-queue"></canvas></div></div>
  </div>
  <div class="card mt"><h3>Most urgent — projected stockouts</h3><div class="hint">Top of the replenishment queue, ordered by days to stockout.</div><div id="ovi-tbl"><div class="loading">{ LOADING }</div></div></div>`,
'ov-margin':m=>header(m,'Margin &amp; pricing — summary','Rolls up Pricing &amp; Markdowns: going-in margin, what markdowns are taking back, and what price events are about to do to the forecast.')+`
  <div class="kpis autoload" id="ovm-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="row2">
    <div class="card"><h3>Weekly margin dollars vs promo sales</h3><div class="hint">The gap between the bars is the price the top line is paying for volume.</div><div class="chartbox"><canvas id="ch-ovm-margin"></canvas></div></div>
    <div class="card"><h3>Season sell-through vs the markdown ladder</h3><div class="hint">Cumulative sell-through against the policy trigger. Detail in Pricing &amp; Markdowns → Markdown Management.</div><div class="chartbox"><canvas id="ch-ovm-season"></canvas></div></div>
  </div>
  <div class="card mt"><h3>Price &amp; markdown events landing next</h3><div class="hint">Each event carries its store execution state — this is what feeds the finance forecast and the Communications section.</div><div id="ovm-tbl"><div class="loading">{ LOADING }</div></div></div>`,
'ov-ops':m=>header(m,'Operations &amp; vendors — summary','Rolls up Operations and Vendor Management: how much of the close is clearing itself, what is stuck, and what vendors are telling us.')+`
  <div class="kpis autoload" id="ovo-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="row2">
    <div class="card"><h3>Variance identified vs recovered</h3><div class="hint">The recovery engine by month; line is auto-clear rate. Line-level clear / debit / hold is <a href="#" onclick="show('matchq');return false">Exception triage</a>.</div><div class="chartbox"><canvas id="ch-ovo-trend"></canvas></div></div>
    <div class="card"><h3>Store task board</h3><div class="hint">Everything the app has asked stores to do, and whether they did it.</div><div class="chartbox"><canvas id="ch-ovo-tasks"></canvas></div></div>
  </div>
  <div class="card mt"><h3>Statements blocking payment</h3><div class="hint">A statement is payable only when its exceptions are closed — or paid net of debit memos.</div><div id="ovo-tbl"><div class="loading">{ LOADING }</div></div></div>`,
demand:m=>header(m,'Demand Planning','Forecasted demand becomes purchase timing: slice the timeline, layer the weather signal where there is still time to react, and generate the PO proposal.')+`
  <div class="steps">
    <div class="step"><span class="sn">1</span><div><b>See demand</b><div>Slice the forecast. Storm-driven categories belong on <a href="#" onclick="show('wxopp');return false">Weather opportunities</a> — the 4–10 day window, not the 8-week chart.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Flip to order-by week</b><div>Demand shifted back by observed lead time — this is when the PO must leave, not when the sale lands.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Generate the proposal</b><div>Then bulk-approve it in Replenishment → PO Generator so NetSuite receives a decision, not a dashboard export.</div></div></div>
  </div>
  <div class="card focus autoload mt" id="tlcard">
    <h3>Demand &amp; purchase timeline</h3>
    <div class="hint">Stacked weekly forecast, sliceable by category / brand / vendor / location. Switch the axis to <b>Order-by week</b> to see when purchases must be placed (demand shifted back by each vendor's observed lead time). The weather layer splits into reactable (order window still open) vs missed (lead time already passed).</div>
    <div class="controls" id="tl-controls"></div>
    <div class="chartbox tall"><canvas id="ch-tl"></canvas></div>
    <div class="legend" id="tl-note"></div>
  </div>
  <div class="card mt">
    <h3>Weekly demand matrix — weeks x categories</h3>
    <div class="hint">Each row a week, each column a category. Toggle units vs dollars; filter by region or store. Shading scales within each column.</div>
    <div class="controls" id="mx-controls"></div>
    <div id="mx-table"><div class="loading">{ LOADING }</div></div>
  </div>
  <div class="card mt focus">
    <h3>Proposed PO generator</h3>
    <div class="hint">Order qty per store x SKU = forecast over the horizon (+ weather if layered) + safety stock − current position (on hand + on order + in transit), rolled up to one master PO per vendor. For bulk approve / delay / teammate handoff and NetSuite ingestion, use <a href="#" id="po-to-gen">Planning → Replenishment → PO Generator</a>.</div>
    <div class="controls" id="po-controls"></div>
    <div id="po-out"><div class="loading" style="padding:14px">{ SET CONTROLS AND GENERATE }</div></div>
  </div>
  <div class="card mt">
    <h3>Sales by size vs forecast by size</h3>
    <div class="hint">Avg weekly actual units (last 8 wks) against the model's weekly forecast, with the size-curve expected share overlaid. Red size labels are meat sizes.</div>
    <div class="controls" id="sd-controls"></div>
    <div class="chartbox tall"><canvas id="ch-size"></canvas></div>
    <div class="legend" id="sd-note"></div>
  </div>`,
wxopp:m=>header(m,'Weather opportunities','A 10-day forecast has skill. An 8-week chart does not. This page keeps only the window that is far enough to move goods and close enough to trust — then overlays it on stores already short in rain-lift categories.')+`
  <div class="steps steps-4">
    <div class="step"><span class="sn">1</span><div><b>Lock the skill window</b><div>Days 4–10: reliable enough to act, still inside a transfer or expedite clock. Inside 3 days is nowcast. Past 14 is climatology.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Where weather hits a shortage</b><div>Not rain in the Northwest. Which stores are already broken on meat sizes in the categories that lift when it rains.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Pick the play</b><div>Transfer from a dry sister store, expedite if lead fits, or accept lost sales. Do not raise a seasonal PO on a 10-day signal.</div></div></div>
    <div class="step"><span class="sn">4</span><div><b>Hand it to a queue</b><div>Transfers go to Replenishment. Buys go to PO Generator. Weather is a trigger, not a report.</div></div></div>
  </div>
  <div class="kpis mt autoload" id="wx-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="card focus mt">
    <h3>Forecast skill ribbon — what we will and will not buy against</h3>
    <div class="hint">0–3 day nowcast is too late to buy from a vendor; 4–10 days is the commercial window; 11–14 days is watch-only; beyond that the event dissolves into seasonal climate. Observed vendor lead time still has to fit inside the same window.</div>
    <div class="wx-ribbon" id="wx-ribbon"></div>
    <div class="controls" id="wx-controls"></div>
  </div>
  <div class="row37 mt">
    <div class="card">
      <h3>Network — weather lift vs shortage</h3>
      <div class="hint">Bubble size = weather-adjusted units in the selected window. Red = meat-size breaks in weather-sensitive categories. Click a store for the play.</div>
      <div style="position:relative"><div id="wx-map"></div><div class="maptip" id="wxtip"></div></div>
      <div class="legend" id="wx-map-legend"></div>
    </div>
    <div class="card" id="wx-side"><div class="loading">{ SELECT A STORE }</div></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Weather units by week and band</h3><div class="hint">Green = still inside the skill window. Gray = too far to event-buy. Red = already missed the order-by date for that vendor.</div><div class="chartbox"><canvas id="ch-wx-weeks"></canvas></div></div>
    <div class="card"><h3>Which categories actually lift</h3><div class="hint">Weather sensitivity is empirical: share of forecast that is weather-adj, not a label on the style file.</div><div class="chartbox"><canvas id="ch-wx-cats"></canvas></div></div>
  </div>
  <div class="card mt">
    <h3>Opportunity board — store × category in this window</h3>
    <div class="hint">Transfer-first when vendor lead is longer than days-to-event. Event-buy only when the skill window still covers observed P50 lead.</div>
    <div class="pg-tabs" id="wx-tabs"></div>
    <div id="wx-tbl"><div class="loading">{ LOADING }</div></div>
    <div class="pg-actions" style="margin-top:12px;margin-bottom:0">
      <button class="btn ghost" onclick="show('replen')">Send transfers to Replenishment</button>
      <button class="btn" onclick="show('pogen')">Event-buy in PO Generator</button>
      <span style="font-size:12px;color:var(--sub);align-self:center">A play that stays on this map is still BI.</span>
    </div>
  </div>`,
replen:m=>header(m,'Purchase Planning &amp; Replenishment','Continuous ROP review, size-run break detection, transfer-first suggestions, PO consolidation to tier breaks — and the network map.')+`
  <div class="kpis autoload" id="rep-kpis"></div>
  <div class="card focus">
    <h3>Network variance map</h3>
    <div class="hint">Bubble size = magnitude. Pick a metric and slice by category / brand / size; click a store to break its variance down on the right.</div>
    <div class="controls" id="map-controls"></div>
    <div class="row37">
      <div style="position:relative"><div id="svgmap"></div><div class="maptip" id="maptip"></div></div>
      <div><div id="map-side"><div class="loading">{ SELECT A STORE }</div></div></div>
    </div>
    <div class="legend" id="map-legend"></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Receipt date variance — every PO receipt, 12 months</h3><div class="hint">Days late (+) or early (−) vs quoted lead time. The drift is the lead-time forecasting problem: quoted lead times are systematically optimistic.</div><div class="chartbox"><canvas id="ch-lt-scatter"></canvas></div></div>
    <div class="card"><h3>Quoted vs actual lead time by vendor</h3><div class="hint">Median and P90 actual vs the lead time we plan with. Planning at quoted = built-in stockouts; the engine plans at observed P50 with P90 safety.</div><div class="chartbox"><canvas id="ch-lt-vendor"></canvas></div></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Size-run health by store</h3><div class="hint">Style/color runs: intact vs fringe vs meat-size breaks.</div><div class="chartbox"><canvas id="ch-runs"></canvas></div></div>
    <div class="card"><h3>Suggestion queue — most urgent</h3><div class="hint">Ordered by projected stockout date. Approved buys leave this queue and land in <a href="#" onclick="show('pogen');return false">PO Generator</a> for bulk decisioning.</div><div id="rep-tbl"><div class="loading">{ LOADING }</div></div></div>
  </div>`,
pogen:m=>header(m,'PO Generator','Turn hundreds of proposed store POs into three piles: approve on conditions, delay what is not needed yet, and hand the gray area to a teammate — then export the approved set into NetSuite.')+`
  <div class="kpis autoload" id="pg-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="steps">
    <div class="step"><span class="sn">1</span><div><b>Classify at scale</b><div>Rules score every proposed store PO so you are not clicking line by line.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Act on the piles</b><div>Approve the obvious, delay the healthy, assign the rest with a question.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Export to NetSuite</b><div>Same payload, several ingestion paths — CSV, EDI 850, API, File Cabinet.</div></div></div>
  </div>
  <div class="card focus mt">
    <h3>Step 1 — condition rules — bulk classify</h3>
    <div class="hint">Apply a rule to every matching proposed PO still in the queue. Engine recommendations run on load; override with the conditions below when policy changes.</div>
    <div class="controls" id="pg-rule-controls"></div>
    <div class="pg-rules" id="pg-rules"></div>
    <div class="controls" style="margin-top:8px;margin-bottom:0">
      <div style="align-self:flex-end"><button class="btn" id="pg-apply">Apply selected rule to matches</button></div>
      <div style="align-self:flex-end"><button class="btn ghost" id="pg-reset">Reset to engine recommendations</button></div>
      <span id="pg-rule-msg" style="align-self:center;font-size:12px;color:var(--sub)"></span>
    </div>
  </div>
  <div class="card mt">
    <h3>Step 2 — decision queue</h3>
    <div class="hint">Direct-to-store: one proposed mini-PO per store × vendor, rolled under a master PO per vendor. Check rows, then approve, delay, or bring in a teammate.</div>
    <div class="pg-tabs" id="pg-tabs"></div>
    <div class="controls" id="pg-queue-controls"></div>
    <div class="pg-actions" id="pg-actions"></div>
    <div id="pg-tbl"><div class="loading">{ LOADING }</div></div>
  </div>
  <div class="card mt" id="pg-export-card" style="display:none">
    <h3>Step 3 — export approved POs into NetSuite</h3>
    <div class="hint">The workflow is the same payload. Pick how merchandising hands it to ERP — download-and-upload, EDI, API, or a File Cabinet job. Nothing posts in this demo.</div>
    <div class="export-grid" id="pg-export-grid"></div>
    <div id="pg-export-preview"></div>
  </div>`,
ats:m=>header(m,'Vendor Availability (ATS)','What vendors can actually ship — EDI 846 for Tier A, portal pulls for Tier B, parsed email for Tier C.')+`
  <div class="card focus autoload" id="ats-tbl"><div class="loading">{ LOADING }</div></div>
  <div class="card mt"><h3>Acquisition plan</h3><ul class="feat">
    <li><b>Tier A (live):</b> Carhartt &amp; Wolverine EDI 846 via existing SPS Commerce pipe</li>
    <li><b>Tier B (Phase 2):</b> portal downloads / credentialed RPA</li>
    <li><b>Tier C (opportunistic):</b> parsed email sheets, human-confirmed</li></ul></div>`,
deals:m=>header(m,'Vendor Programs &amp; Opportunity Buys','Tier-break coordination, closeouts, SMUs, preseason books — AI-scored for margin uplift vs weeks-of-supply risk.')+`
  <div class="kpis autoload" id="deal-kpis"></div>
  <div class="card focus" id="deal-tbl"><div class="loading">{ LOADING }</div></div>`,
match:m=>header(m,'3-Way Match analysis','Why the close is long: every store PO, receiver, invoice and statement on one tree — and whether the nightly engine cleared the line or parked an exception. Work the exceptions next door, not here.')+`
  <div class="kpis autoload" id="m-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="steps steps-4">
    <div class="step"><span class="sn">1</span><div><b>Documents land</b><div>Master PO → store mini-PO → receiver → vendor invoice → master statement. Direct-to-store, not a warehouse ASN.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Nightly line match</b><div>Qty and cost on PO vs received vs invoiced. Clean lines auto-clear. No one opens those in NetSuite.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Exceptions park</b><div>Price, short-ship, freight. Aged dollars are the close-cycle killers — this page shows where they sit.</div></div></div>
    <div class="step"><span class="sn">4</span><div><b>Pay-file gate</b><div>A statement pays only when exceptions are closed or net of debit memos. Release happens in Exception triage.</div></div></div>
  </div>
  <div class="card focus mt">
    <h3>Document explorer — one vendor buy, end to end</h3>
    <div class="hint">Pick a master PO to walk the tree. This is the diagnostic: which store is blocking the statement. To clear, debit, or hold those lines in NetSuite, open <a href="#" onclick="show('matchq');return false">Exception triage</a>.</div>
    <div class="controls" id="doc-controls"></div>
    <div id="doc-summary"></div>
    <div id="doc-tree"><div class="loading">{ LOADING }</div></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Variance identified vs recovered by month</h3><div class="hint">The recovery engine at work — line = auto-clear rate (right axis). A dashboard until triage posts the debit or write-off.</div><div class="chartbox"><canvas id="ch-mtrend"></canvas></div></div>
    <div class="card"><h3>Open exception aging &amp; root cause</h3><div class="hint">Aging buckets by count; donut = open $ by cause. Use this to set triage rules (e.g. auto-clear &lt; $25, debit qty shorts).</div><div class="row2"><div class="chartbox" style="height:240px"><canvas id="ch-mage"></canvas></div><div class="chartbox" style="height:240px"><canvas id="ch-var"></canvas></div></div></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Master statement reconciliation</h3><div class="hint">Pay-file diagnostic: payable, pay-less-debits, or hold. Clearing the hold is a triage action, not a chart.</div><div id="m-stmt"><div class="loading">{ LOADING }</div></div></div>
    <div class="card"><h3>What is waiting on a human</h3><div class="hint">Rolled up from the exception queue — line-level work lives on the next page.</div><div id="m-tbl"><div class="loading">{ LOADING }</div></div></div>
  </div>`,
matchq:m=>header(m,'Exception triage','The close is a queue, not a project: bulk-clear noise, debit what we can recover, hold what is still in transit, and hand the rest to AP or the buyer — then post the decisions to NetSuite.')+`
  <div class="kpis autoload" id="mx-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="steps">
    <div class="step"><span class="sn">1</span><div><b>Classify by rule</b><div>Tolerance, qty short, aged material, freight — score every open line so AP is not clicking invoices one at a time.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Act on the piles</b><div>Clear, debit, hold, or assign with a question. Same pattern as PO Generator: humans on the gray area only.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Post to NetSuite</b><div>Vendor bill variances, debit memos, and pay-file holds — CSV, REST, EDI 812, or File Cabinet job.</div></div></div>
  </div>
  <div class="card focus mt">
    <h3>Step 1 — condition rules</h3>
    <div class="hint">Engine recommendations run on load from the open exception queue. Apply a rule to every match still in play; analysis of aging and cause lives on <a href="#" onclick="show('match');return false">3-Way Match analysis</a>.</div>
    <div class="controls" id="mx-rule-controls"></div>
    <div class="pg-rules" id="mx-rules"></div>
    <div class="controls" style="margin-top:8px;margin-bottom:0">
      <div style="align-self:flex-end"><button class="btn" id="mx-apply">Apply selected rule to matches</button></div>
      <div style="align-self:flex-end"><button class="btn ghost" id="mx-reset">Reset to engine recommendations</button></div>
      <span id="mx-rule-msg" style="align-self:center;font-size:12px;color:var(--sub)"></span>
    </div>
  </div>
  <div class="card mt">
    <h3>Step 2 — decision queue</h3>
    <div class="hint">Each row is a matched line the nightly job could not auto-clear. Check rows, then clear, debit, hold payment, or bring in a teammate.</div>
    <div class="pg-tabs" id="mx-tabs"></div>
    <div class="controls" id="mx-queue-controls"></div>
    <div class="pg-actions" id="mx-actions"></div>
    <div id="mx-tbl"><div class="loading">{ LOADING }</div></div>
  </div>
  <div class="card mt" id="mx-export-card" style="display:none">
    <h3>Step 3 — post approved decisions to NetSuite</h3>
    <div class="hint">Cleared lines write off or accept the bill. Debit pile becomes vendor credits / debit memos. Holds stay off the pay file. Same payload, several ingestion paths. Nothing posts in this demo.</div>
    <div class="export-grid" id="mx-export-grid"></div>
    <div id="mx-export-preview"></div>
  </div>`,
pricing:m=>header(m,'Pricing &amp; Promotion','Vendor price files in → staged ERP updates out. Every event carries its margin impact, its pre-buy option, and its store execution trail.')+`
  <div class="steps">
    <div class="step"><span class="sn">1</span><div><b>Ingest the vendor file</b><div>EDI 832, portal, or parsed email — diffs land against price_master. Nothing touches the ERP yet.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Approve with margin in view</b><div>Follow-the-retail and the 6-week pre-buy are decisions, not surprises after the file posts.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Write NetSuite + stores</b><div>Approved events stage the price, spawn retag tasks, and draft the change digest. That is the operational effect.</div></div></div>
  </div>
  <div class="kpis autoload mt" id="pr-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="card focus" id="pr-pipe"><div class="loading">{ LOADING }</div></div>
  <div class="row2 mt">
    <div class="card"><h3>Margin impact preview — Carhartt increase, effective 8/1</h3><div class="hint">Cost +5.5%, retail +10% staged from the vendor 832 file. Bars: margin % before vs after. The follow-the-retail decision is explicit, not accidental.</div><div class="chartbox"><canvas id="ch-pr-impact"></canvas></div><div class="legend" id="pr-impact-note"></div></div>
    <div class="card"><h3>Pre-buy option — announced increases</h3><div class="hint">Buy at today's cost before the effective date, capped at a 6-weeks-of-supply guardrail so a price play never becomes a markdown problem.</div><div class="chartbox"><canvas id="ch-pr-prebuy"></canvas></div><div class="legend" id="pr-prebuy-note"></div></div>
  </div>
  <div class="row2 mt">
    <div class="card" id="pr-prebuy-tbl"><div class="loading">{ LOADING }</div></div>
    <div class="card"><h3>Price file ingestion — by vendor tier</h3><div class="hint">How price updates reach staging. Nothing touches the ERP without an approval click.</div><div id="pr-sources"><div class="loading">{ LOADING }</div></div>
      <ul class="feat" style="margin-top:10px">
        <li><b>Stage → approve → ERP:</b> diffs land against price_master; a buyer approves; the app writes back (or hands a file to the ERP import).</li>
        <li><b>Execution trail:</b> approved events auto-spawn retag/label tasks per store and an LLM-drafted change digest (Communications).</li>
        <li><b>Promo orchestration:</b> PromoStart/PromoEnd events coordinate POS price, endcap task, and label windows.</li></ul></div>
  </div>`,
markdown:m=>header(m,'Markdown Management','Fewer, later, smarter markdowns: sell-through triggers the ladder, the floor protects margin, experiments tune the timing, and stores get the label files.')+`
  <div class="steps">
    <div class="step"><span class="sn">1</span><div><b>Trigger, don't calendar</b><div>Sell-through vs the ladder — mark down because the season said so.</div></div></div>
    <div class="step"><span class="sn">2</span><div><b>Protect the floor</b><div>Skip steps that destroy margin. Timing is a test, not a habit.</div></div></div>
    <div class="step"><span class="sn">3</span><div><b>Execute in stores</b><div>Label files and checklist tasks print locally and track to done. That is the operational effect.</div></div></div>
  </div>
  <div class="kpis autoload mt" id="md-kpis"><div class="loading">{ LOADING FROM DATABRICKS }</div></div>
  <div class="card focus">
    <h3>Rainwear season — sell-through vs the ladder</h3>
    <div class="hint">Weekly units (bars) and cumulative sell-through (line, right axis) against the MD-001 trigger. Orange markers = ladder steps. The question the chart answers: did we mark down because the season said so, or because the calendar did?</div>
    <div class="chartbox tall"><canvas id="ch-md-season"></canvas></div>
    <div class="legend" id="md-season-note"></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Ladder economics vs the floor</h3><div class="hint">Margin % at each step for the style selected — red bars breach the policy floor (dashed line): those steps clear inventory but destroy margin, so the win is never needing them.</div>
      <div class="controls" id="md-ladder-controls"></div>
      <div class="chartbox"><canvas id="ch-md-ladder"></canvas></div></div>
    <div class="card"><h3>Policy board</h3><div class="hint">Ladders by scope with triggers and floors. MD-004 is the delayed-ladder test variant.</div><div id="md-policies"><div class="loading">{ LOADING }</div></div></div>
  </div>
  <div class="row2 mt">
    <div class="card"><h3>Timing experiments — what the tests say</h3><div class="hint">Markdown timing is a testable hypothesis, not a habit. AI summarizes each test and recommends the rollout decision.</div><div id="md-exps"><div class="loading">{ LOADING }</div></div></div>
    <div class="card"><h3>Markdown execution trail</h3><div class="hint">Each markdown event spawns per-store label files and checklist tasks — printed locally, tracked to completion.</div><div id="md-events"><div class="loading">{ LOADING }</div></div></div>
  </div>`,
ask:m=>header(m,'Ask SolutionSet','A governed analyst over the merchandising layer. Ask in plain English; the app writes the query, runs it against Databricks, and shows you both the answer and the SQL behind it.')+`
  <div class="askgrid">
    <div>
      <div class="askhead">
        <div class="tag">Governed analyst over sset1000.supplychain · read-only · every result exports</div>
        <button class="btn ghost" id="ask-new" style="margin-left:auto;padding:6px 13px;font-size:12px">New chat</button>
      </div>
      <div class="thread" id="ask-thread"></div>
      <div class="askform">
        <textarea id="ask-input" placeholder="Ask about the numbers… (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="btn" id="ask-send" style="padding:0 26px">Send</button>
      </div>
      <div class="chips" id="ask-chips"></div>
    </div>
    <div>
      <div class="railcard">
        <h4>What the analyst can see</h4>
        <div class="cap">24 governed views · read-only</div>
        <p id="ask-scope">Sales, inventory and forecast facts; the replenishment queue and proposed PO generator; 3-way match analysis and the exception triage queue; vendor lead times, availability and deals; price and markdown events; store tasks. It cannot see anything outside the governed layer, and it cannot write.</p>
      </div>
      <div class="railcard">
        <h4>Context documents</h4>
        <div class="cap">The analyst reads these when relevant · .txt .md .csv .json</div>
        <p>Document storage lands with the next data-layer update.</p>
      </div>
      <div class="railcard">
        <h4>Saved analyses</h4>
        <div class="cap">Save an answer, reopen it with its data intact</div>
        <p>The analysis library lands with the next data-layer update.</p>
      </div>
    </div>
  </div>`,
comms:m=>header(m,'Team Communications &amp; Store Tasks','Condition triggers event, event warrants a typed communication: LLM-drafted, human-approved, routed to the right stakeholders — with store checklists and overdue escalation.')+`
  <div class="kpis autoload" id="c-kpis"></div>
  <div class="card focus" id="c-tbl"><div class="loading">{ LOADING }</div></div>`,
admin:m=>header(m,'Data Health','Feed freshness and crossref completeness — housekeeping made visible. Reference-table stewardship moves to the next page.')+`
  <div class="card focus autoload" id="a-tbl"><div class="loading">{ LOADING }</div></div>`,
refedit:m=>header(m,'Reference Tables','The tables merchandising owns by hand — size curves, markdown policy, lead times, tier pricing, replenishment parameters, vendor crossrefs. Edit here, review the change set, then submit it.')+`
  <div class="warnbox autoload" id="ref-warn">
    <b>Nothing on this page writes to Databricks.</b> Edits are staged in the browser. When you are happy with them, generate the change set and send it — SolutionSet applies it against the governed layer and the change appears on the next load. This keeps a human approval between a typed number and a production table.
  </div>
  <div class="card focus">
    <div class="controls" id="ref-controls"></div>
    <div id="ref-note" class="hint" style="margin-bottom:10px"></div>
    <div id="ref-table"><div class="loading">{ LOADING }</div></div>
  </div>
  <div class="card mt" id="ref-diffcard">
    <h3>Staged changes <span id="ref-count" class="chip gray">0</span></h3>
    <div class="hint">Every edit on this page, across every reference table, collected into one reviewable change set.</div>
    <div id="ref-diff"><div class="loading" style="padding:16px">{ NO CHANGES STAGED }</div></div>
    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn" id="ref-gen" disabled>Generate change set</button>
      <button class="btn ghost" id="ref-copy" disabled>Copy SQL</button>
      <button class="btn ghost" id="ref-reset" disabled>Discard all</button>
      <span id="ref-msg" style="font-size:11.5px;color:var(--sub)"></span>
    </div>
    <textarea id="ref-sql" style="display:none;width:100%;height:180px;margin-top:12px;font-family:Consolas,monospace;font-size:11px;border:1px solid #C9D6EC;border-radius:8px;padding:10px"></textarea>
  </div>`,
};

// ---------------- loaders ----------------
const LOADERS={
async 'ov-exec'(){
  // ---------- KPI strip with sparklines ----------
  let tr=await runQ(`SELECT * FROM ${S}.sales_trend_v ORDER BY week_start`);
  // drop a trailing partial week (anchor lands mid-week)
  if(tr.length>3){
    const med=[...tr].map(r=>+r.net_sales).sort((a,b)=>a-b)[Math.floor(tr.length/2)];
    if(+tr[tr.length-1].net_sales < med*0.4) tr=tr.slice(0,-1);
  }
  const W=tr.slice(-26), N=13;
  const cur=tr.slice(-N), prv=tr.slice(-2*N,-N);
  const sum=(a,k)=>a.reduce((x,r)=>x+ +r[k],0);
  const pctD=(c,p)=> (p&&isFinite(p)&&p!==0)? ((c-p)/Math.abs(p))*100 : null;
  const mmd=s=>{const d=new Date(String(s).slice(0,10)+'T00:00:00Z');
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});};
  const axL=mmd(W[0].week_start), axR=mmd(W[W.length-1].week_start);
  const cS=sum(cur,'net_sales'), pS=sum(prv,'net_sales');
  const cM=sum(cur,'margin_dollars'), pM=sum(prv,'margin_dollars');
  const cU=sum(cur,'units'), pU=sum(prv,'units');
  const cP=sum(cur,'promo_sales'), pP=sum(prv,'promo_sales');
  const cR=sum(cur,'rain_day_sales'), pR=sum(prv,'rain_day_sales');
  const sMar=W.map(r=>+r.net_sales? 100*(+r.margin_dollars)/(+r.net_sales):0);
  const sAUR=W.map(r=>+r.units? (+r.net_sales)/(+r.units):0);
  const sPro=W.map(r=>+r.net_sales? 100*(+r.promo_sales)/(+r.net_sales):0);
  const peak=(arr,f)=>f(Math.max(...arr));
  const K=[
   {label:'Net sales', value:fmt$(cS), deltaPct:pctD(cS,pS), periodLabel:'13 wks', series:W.map(r=>+r.net_sales),
    color:'#2E5BFF', axisL:axL, axisM:'peak '+fmt$(Math.max(...W.map(r=>+r.net_sales))), axisR:axR},
   {label:'Gross margin $', value:fmt$(cM), deltaPct:pctD(cM,pM), periodLabel:'13 wks', series:W.map(r=>+r.margin_dollars),
    color:'#1E9E5A', axisL:axL, axisM:'peak '+fmt$(Math.max(...W.map(r=>+r.margin_dollars))), axisR:axR},
   {label:'Margin %', value:(cS? (100*cM/cS):0).toFixed(1)+'%', deltaPct:pctD(cS?cM/cS:0, pS?pM/pS:0), periodLabel:'13 wks',
    series:sMar, color:'#1F2A44', axisL:axL, axisM:`${Math.min(...sMar).toFixed(0)}–${Math.max(...sMar).toFixed(0)}%`, axisR:axR},
   {label:'Units sold', value:fmtN(cU), deltaPct:pctD(cU,pU), periodLabel:'13 wks', series:W.map(r=>+r.units),
    color:'#7C4DBE', axisL:axL, axisM:'peak '+fmtN(Math.max(...W.map(r=>+r.units))), axisR:axR},
   {label:'Average unit retail', value:'$'+(cU? cS/cU:0).toFixed(2), deltaPct:pctD(cU?cS/cU:0, pU?pS/pU:0), periodLabel:'13 wks',
    series:sAUR, color:'#1B9E9E', axisL:axL, axisM:`$${Math.min(...sAUR).toFixed(0)}–$${Math.max(...sAUR).toFixed(0)}`, axisR:axR},
   {label:'Promo share of sales', value:(cS?100*cP/cS:0).toFixed(1)+'%', deltaPct:pctD(cS?cP/cS:0, pS?pP/pS:0), periodLabel:'13 wks',
    inverse:true, series:sPro, color:'#C55A11', axisL:axL, axisM:`${Math.min(...sPro).toFixed(0)}–${Math.max(...sPro).toFixed(0)}%`, axisR:axR},
   {label:'Rain-day sales', value:fmt$(cR), deltaPct:pctD(cR,pR), periodLabel:'13 wks', series:W.map(r=>+r.rain_day_sales),
    color:'#4A79C7', axisL:axL, axisM:'weather-driven demand', axisR:axR},
  ];
  document.getElementById('ov-kpis').innerHTML=K.map(sparkKPI).join('');
  // ---------- trend chart ----------
  const labels=tr.map(r=>String(r.week_start).slice(0,10));
  mkChart('ch-ov-trend','bar',{labels,datasets:[
    {label:'Net sales',type:'line',data:tr.map(r=>+r.net_sales),borderColor:'#2E5BFF',backgroundColor:'rgba(46,91,255,.08)',fill:true,tension:.3,pointRadius:0,borderWidth:2,order:1},
    {label:'Gross margin $',data:tr.map(r=>+r.margin_dollars),backgroundColor:'#1F2A44',order:2},
    {label:'Promo sales',data:tr.map(r=>+r.promo_sales),backgroundColor:'#C55A11',order:2}]},
    {scales:{x:{ticks:{maxTicksLimit:12}},y:{ticks:{callback:v=>'$'+(v/1000)+'k'}}}});
  // ---------- killer visual: parameterized network map ----------
  const V=await runQ(`SELECT * FROM ${S}.store_variance_v`);
  const cats=uniq(V.map(r=>r.category)).sort(), brands=uniq(V.map(r=>r.brand)).sort(), sizes=uniq(V.map(r=>r.size)).sort(sizeSort);
  document.getElementById('ov-map-controls').innerHTML=`
   <div><label>Metric</label><select id="ov-metric">
     <option value="var">Sales vs plan variance %</option>
     <option value="sales">Actual sales $</option>
     <option value="units">Actual units</option>
     <option value="lost">Lost sales $ (stockouts)</option>
     <option value="outs">Stockout positions</option>
     <option value="meat">Meat-size breaks</option></select></div>
   <div><label>Category</label><select id="ov-cat"><option value="">All</option>${cats.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Brand</label><select id="ov-brand"><option value="">All</option>${brands.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Size</label><select id="ov-size"><option value="">All</option>${sizes.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Break down by</label><select id="ov-dim"><option value="category">Category</option><option value="brand">Brand</option><option value="size">Size</option></select></div>`;
  const g=id=>document.getElementById(id).value;
  let ovSel=null;
  const META={var:{t:'Sales vs plan variance %',mode:'signed',f:x=>(x>0?'+':'')+x.toFixed(1)+'%'},
              sales:{t:'Actual sales $',mode:'neutral',f:x=>fmt$(x)},
              units:{t:'Actual units',mode:'neutral',f:x=>fmtN(x)},
              lost:{t:'Lost sales $',mode:'bad',f:x=>fmt$(x)},
              outs:{t:'Stockout positions',mode:'bad',f:x=>fmtN(x)},
              meat:{t:'Meat-size breaks',mode:'bad',f:x=>fmtN(x)}};
  function ovFilt(){ const c=g('ov-cat'),b=g('ov-brand'),s=g('ov-size');
    return V.filter(r=>(!c||r.category===c)&&(!b||r.brand===b)&&(!s||r.size===s)); }
  function ovAgg(rows){
    const o={};
    rows.forEach(r=>{ const k=r.store_id;
      o[k]=o[k]||{store_id:k,store_name:r.store_name,latitude:r.latitude,longitude:r.longitude,a:0,e:0,sales:0,outs:0,meat:0,lost:0};
      o[k].a+=+r.actual_units; o[k].e+=+r.expected_units; o[k].sales+=+r.actual_sales;
      o[k].outs+=+r.outs; o[k].meat+=+r.meat_outs; o[k].lost+=+r.lost_sales; });
    return Object.values(o);
  }
  function ovVal(s){ const m=g('ov-metric');
    if(m==='var') return s.e>0? +(100*(s.a-s.e)/s.e).toFixed(1):0;
    if(m==='sales') return Math.round(s.sales); if(m==='units') return s.a;
    if(m==='lost') return Math.round(s.lost); if(m==='outs') return s.outs; return s.meat; }
  function ovRender(){
    const m=g('ov-metric'), meta=META[m];
    const stores=ovAgg(ovFilt());
    document.getElementById('ovmap').innerHTML=mapSVG2(stores, ovVal, meta.mode, ovSel);
    const scope=`${g('ov-cat')||'all categories'}${g('ov-brand')?' / '+g('ov-brand'):''}${g('ov-size')?' / size '+g('ov-size'):''}`;
    document.getElementById('ov-map-legend').innerHTML= meta.mode==='signed'
      ? `<span><span class="dot" style="background:#1E9E5A"></span>Over plan</span><span><span class="dot" style="background:#C0392B"></span>Under plan</span><span>Metric: <b>${meta.t}</b> · scope: ${scope} · last 8 weeks</span>`
      : meta.mode==='bad'
      ? `<span><span class="dot" style="background:#C0392B"></span>Higher = worse</span><span>Metric: <b>${meta.t}</b> · scope: ${scope}</span>`
      : `<span><span class="dot" style="background:#2E5BFF"></span>Bubble size = ${meta.t.toLowerCase()}</span><span>Scope: ${scope}</span>`;
    const tip=document.getElementById('ovmaptip');
    document.querySelectorAll('#ovmap circle.store').forEach(c=>{
      const s=stores[+c.dataset.i];
      c.addEventListener('mousemove',ev=>{
        tip.style.display='block';
        const host=document.getElementById('ovmap').getBoundingClientRect();
        tip.style.left=(ev.clientX-host.left+14)+'px'; tip.style.top=(ev.clientY-host.top-10)+'px';
        tip.innerHTML=`<b>${s.store_id} — ${esc(s.store_name)}</b><br>${meta.t}: <b>${meta.f(ovVal(s))}</b><br>${fmt$(s.sales)} sales · ${fmtN(s.a)} units vs ${fmtN(Math.round(s.e))} plan<br>${s.outs} outs · ${s.meat} meat breaks · ${fmt$(s.lost)} lost`;
      });
      c.addEventListener('mouseleave',()=>tip.style.display='none');
      c.addEventListener('click',()=>{ ovSel=(ovSel===s.store_id?null:s.store_id); ovRender(); ovSide(); });
    });
  }
  function ovSide(){
    const m=g('ov-metric'), meta=META[m], side=document.getElementById('ov-map-side');
    if(!ovSel){
      const stores=ovAgg(ovFilt()).map(s=>({k:s.store_id+' '+s.store_name.slice(0,14),v:ovVal(s)}));
      stores.sort((a,b)=> meta.mode==='signed'? a.v-b.v : b.v-a.v);
      const top=stores.slice(0,12);
      side.innerHTML=`<h3 style="margin-bottom:2px">${meta.mode==='signed'?'Weakest 12 stores':'Top 12 stores'}</h3>
        <div class="hint">Click any bubble on the map to break a single store down.</div>
        <div class="chartbox tall"><canvas id="ch-ovmapside"></canvas></div>`;
      mkChart('ch-ovmapside','bar',{labels:top.map(i=>i.k),datasets:[{label:meta.t,data:top.map(i=>+i.v.toFixed(1)),
        backgroundColor:top.map(i=> meta.mode==='signed'?(i.v<0?'#C0392B':'#1E9E5A'): meta.mode==='bad'?'#C0392B':'#2E5BFF')}]},
        {indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{callback:x=>meta.f(x)}}}});
      return;
    }
    const dim=g('ov-dim');
    const rows=ovFilt().filter(r=>r.store_id===ovSel);
    const o={};
    rows.forEach(r=>{ const k=r[dim]; o[k]=o[k]||{a:0,e:0,sales:0,outs:0,meat:0,lost:0};
      o[k].a+=+r.actual_units; o[k].e+=+r.expected_units; o[k].sales+=+r.actual_sales;
      o[k].outs+=+r.outs; o[k].meat+=+r.meat_outs; o[k].lost+=+r.lost_sales; });
    let items=Object.entries(o).map(([k,x])=>({k, v: m==='var'?(x.e>0?100*(x.a-x.e)/x.e:0): m==='sales'?x.sales: m==='units'?x.a: m==='lost'?x.lost: m==='outs'?x.outs:x.meat}));
    items=items.filter(i=>i.v!==0);
    items.sort((p,q)=> meta.mode==='signed'? p.v-q.v : q.v-p.v);
    if(dim==='size') items.sort((p,q)=>sizeSort(p.k,q.k));
    const nm=(ovAgg(rows)[0]||{}).store_name||ovSel;
    side.innerHTML=`<h3 style="margin-bottom:2px">${ovSel} — ${esc(nm)}</h3>
      <div class="hint">${meta.t} by ${dim} · click the bubble again to go back to the ranking.</div>
      <div class="chartbox tall"><canvas id="ch-ovmapside"></canvas></div>`;
    mkChart('ch-ovmapside','bar',{labels:items.slice(0,14).map(i=>i.k),datasets:[{label:meta.t,
      data:items.slice(0,14).map(i=>+i.v.toFixed(1)),
      backgroundColor:items.slice(0,14).map(i=> meta.mode==='signed'?(i.v<0?'#C0392B':'#1E9E5A'): meta.mode==='bad'?'#C0392B':'#2E5BFF')}]},
      {indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{callback:x=>meta.f(x)}}}});
  }
  ['ov-metric','ov-cat','ov-brand','ov-size'].forEach(id=>document.getElementById(id).onchange=()=>{ovRender();ovSide();});
  document.getElementById('ov-dim').onchange=ovSide;
  ovRender(); ovSide();
  // ---------- attention list ----------
  const [kpi]=await runQ(`SELECT * FROM ${S}.kpi_summary_v`);
  const A=[
   ['Open 3-way exceptions', kpi.open_exceptions, fmt$(kpi.open_exception_amt)+' awaiting recovery', 'Operations → Exception triage', +kpi.open_exceptions>0],
   ['Replenishment suggestions', kpi.replen_suggestions, kpi.expedite_checks+' flagged for expedite', 'Planning → Replenishment', +kpi.replen_suggestions>0],
   ['Meat-size breaks', kpi.meat_outs, 'core sizes out of stock right now', 'Planning → Replenishment', +kpi.meat_outs>0],
   ['Open vendor offers', kpi.open_deals, fmt$(kpi.open_deal_savings)+' savings on the table', 'Vendor Management → Deals', +kpi.open_deals>0],
   ['Overdue store tasks', kpi.overdue_tasks, 'of '+kpi.open_tasks+' open', 'Communications', +kpi.overdue_tasks>0],
   ['Estimated lost sales — 30 days', fmt$(kpi.est_lost_sales_30d), 'attributed to stockout positions', 'Overview → Inventory & service', +kpi.est_lost_sales_30d>0],
  ];
  document.getElementById('ov-attn').innerHTML=table(A.map(a=>({a})),[
    {h:'Item',f:r=>`<b>${r.a[0]}</b><br><span style="color:var(--sub)">${r.a[2]}</span>`},
    {h:'Count',f:r=>`<span style="font-size:16px;font-weight:700;color:${r.a[4]?'var(--orange)':'var(--green)'}">${r.a[1]}</span>`,num:1},
    {h:'Lives in',f:r=>`<span style="font-size:11.5px;color:var(--sub)">${r.a[3]}</span>`}]);
},
async 'ov-inv'(){
  const [kpi]=await runQ(`SELECT * FROM ${S}.kpi_summary_v`);
  document.getElementById('ovi-kpis').innerHTML=[
   ['In-stock rate', kpi.in_stock_pct+'%', kpi.total_outs+' positions out', Number(kpi.in_stock_pct)>=95?'good':'warn'],
   ['Meat-size breaks', kpi.meat_outs, 'core sizes out now', Number(kpi.meat_outs)>0?'bad':'good'],
   ['Inventory turns', kpi.inventory_turns, 'guardrail: watch against in-stock', ''],
   ['Replen queue', kpi.replen_suggestions, kpi.expedite_checks+' need an expedite check', ''],
   ['Est. lost sales — 30d', fmt$(kpi.est_lost_sales_30d), 'on '+fmt$(kpi.sales_30d)+' of sales', 'warn'],
  ].map(k=>`<div class="kpi ${k[3]}"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
  const runs=await runQ(`SELECT store_id, sum(CASE WHEN run_status='MeatBreak' THEN 1 ELSE 0 END) meat, sum(CASE WHEN run_status='FringeBreak' THEN 1 ELSE 0 END) fringe, sum(CASE WHEN run_status='Intact' THEN 1 ELSE 0 END) intact FROM ${S}.size_run_health_v GROUP BY 1 ORDER BY 1`);
  mkChart('ch-ovi-runs','bar',{labels:runs.map(r=>r.store_id),datasets:[
    {label:'Meat break',data:runs.map(r=>+r.meat),backgroundColor:'#C0392B'},
    {label:'Fringe break',data:runs.map(r=>+r.fringe),backgroundColor:'#C55A11'},
    {label:'Intact',data:runs.map(r=>+r.intact),backgroundColor:'#1E9E5A'}]},
    {scales:{x:{stacked:true},y:{stacked:true}}});
  const q=await runQ(`SELECT action, count(*) n FROM ${S}.replen_queue_v GROUP BY 1 ORDER BY n DESC`);
  mkChart('ch-ovi-queue','bar',{labels:q.map(r=>r.action),datasets:[{label:'Suggestions',data:q.map(r=>+r.n),
    backgroundColor:q.map(r=>({Order:'#2E5BFF',TransferFirst:'#7C4DBE',ExpediteCheck:'#C0392B',Hold:'#9fb0cc'})[r.action]||'#2E5BFF')}]},
    {indexAxis:'y',plugins:{legend:{display:false}}});
  const rows=await runQ(`SELECT * FROM ${S}.replen_queue_v ORDER BY days_to_stockout LIMIT 15`);
  document.getElementById('ovi-tbl').innerHTML=table(rows,[
    {h:'Store',k:'store_id'},{h:'Item',f:r=>`<b>${esc(r.brand)}</b> ${esc(r.style_name)}<br><span style="color:var(--sub)">${esc(r.color)} · ${esc(r.size)}</span>`},
    {h:'Action',f:r=>statusChip(r.action)},{h:'Qty',k:'suggested_qty',num:1},
    {h:'Stockout',f:r=>`${String(r.proj_stockout_date).slice(0,10)}<br><span style="color:var(--sub)">${r.days_to_stockout}d</span>`},
    {h:'Note',f:r=>esc(r.tier_break_note||r.reason)}]);
},
async 'ov-margin'(){
  const [kpi]=await runQ(`SELECT * FROM ${S}.kpi_summary_v`);
  const season=await runQ(`SELECT * FROM ${S}.markdown_season_v ORDER BY week_start`);
  const ladder=await runQ(`SELECT * FROM ${S}.markdown_ladder_v`);
  const pipe=await runQ(`SELECT * FROM ${S}.price_event_pipeline_v ORDER BY effective_date`);
  const last=season[season.length-1];
  const floorBreaches=ladder.filter(r=>r.below_floor==='true').length;
  const overdue=pipe.filter(r=>r.workflow_state==='OVERDUE - not staged').length;
  const tOver=pipe.reduce((a,r)=>a+ +r.tasks_overdue,0);
  document.getElementById('ovm-kpis').innerHTML=[
   ['Gross margin', kpi.margin_pct+'%', 'trailing 12 months', ''],
   ['Season sell-through', last.cum_sell_through_pct+'%', fmtN(last.cum_units)+' of est '+fmtN(last.est_season_supply)+' units', +last.cum_sell_through_pct>=60?'good':'warn'],
   ['Floor breaches in ladder', floorBreaches, 'steps priced below the policy floor', floorBreaches?'warn':'good'],
   ['Price events in pipeline', pipe.length, overdue+' overdue, not staged', overdue?'bad':''],
   ['Store tasks overdue', tOver, 'from price & markdown events', tOver?'bad':'good'],
  ].map(k=>`<div class="kpi ${k[3]}"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
  const tr=await runQ(`SELECT * FROM ${S}.sales_trend_v ORDER BY week_start`);
  mkChart('ch-ovm-margin','bar',{labels:tr.map(r=>String(r.week_start).slice(0,10)),datasets:[
    {label:'Margin $',data:tr.map(r=>+r.margin_dollars),backgroundColor:'#1F2A44'},
    {label:'Promo sales',data:tr.map(r=>+r.promo_sales),backgroundColor:'#C55A11'}]},
    {scales:{x:{ticks:{maxTicksLimit:12}},y:{ticks:{callback:v=>'$'+(v/1000)+'k'}}}});
  mkChart('ch-ovm-season','bar',{labels:season.map(r=>String(r.week_start).slice(0,10)),datasets:[
    {label:'Weekly units',data:season.map(r=>+r.units),backgroundColor:'#9fb0cc',order:3},
    {label:'Cumulative sell-through %',type:'line',yAxisID:'y1',data:season.map(r=>+r.cum_sell_through_pct),borderColor:'#2E5BFF',borderWidth:2,pointRadius:0,tension:.25,order:1},
    {label:'Trigger 60%',type:'line',yAxisID:'y1',data:season.map(()=>60),borderColor:'#1F2A44',borderDash:[6,4],borderWidth:1.2,pointRadius:0,order:2}]},
    {scales:{x:{ticks:{maxTicksLimit:10}},y:{title:{display:true,text:'units/wk'}},
      y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false},ticks:{callback:x=>x+'%'}}}});
  const wfChip=s=>({'Executed':'green','ERP updated':'blue','Announced':'gray','OVERDUE - not staged':'red'})[s]||'gray';
  document.getElementById('ovm-tbl').innerHTML=table(pipe,[
    {h:'Event',f:r=>`<span class="mono" style="font-size:11px">${esc(r.event_id)}</span>`},
    {h:'Type',f:r=>`<span class="chip ${({VendorIncrease:'orange',Markdown:'purple',PromoStart:'blue',PromoEnd:'gray'})[r.event_type]||'gray'}">${esc(r.event_type)}</span>`},
    {h:'Vendor',f:r=>`<b>${esc(r.vendor_name)}</b>`},{h:'Scope',k:'scope'},{h:'SKUs',k:'skus_affected',num:1},
    {h:'Effective',f:r=>`${String(r.effective_date).slice(0,10)}<br><span style="color:var(--sub)">${+r.days_to_effective>0?('in '+r.days_to_effective+'d'):(-r.days_to_effective)+'d ago'}</span>`},
    {h:'Workflow',f:r=>`<span class="chip ${wfChip(r.workflow_state)}">${esc(r.workflow_state)}</span>`},
    {h:'Store tasks',f:r=>+r.tasks_total?`${r.tasks_done}/${r.tasks_total} done`+(+r.tasks_overdue?` · <span style="color:var(--red);font-weight:700">${r.tasks_overdue} overdue</span>`:''):'—'}]);
},
async 'ov-ops'(){
  const [k]=await runQ(`SELECT * FROM ${S}.kpi_summary_v`);
  const trend=await runQ(`SELECT * FROM ${S}.match_trend_v ORDER BY match_month`);
  const stmts=await runQ(`SELECT * FROM ${S}.statement_recon_v ORDER BY open_exception_amt DESC, statement_total DESC`);
  const ats=await runQ(`SELECT * FROM ${S}.ats_coverage_v`);
  const recovered=trend.reduce((a,r)=>a+ +r.variance_recovered,0);
  const holds=stmts.filter(r=>r.recon_status!=='Clear to pay');
  const atsItems=ats.reduce((a,r)=>a+ +r.items_reported,0), atsMatched=ats.reduce((a,r)=>a+ +r.items_matched,0);
  document.getElementById('ovo-kpis').innerHTML=[
   ['3-way auto-clear', k.auto_clear_pct+'%', k.open_exceptions+' open · '+fmt$(k.open_exception_amt), Number(k.auto_clear_pct)>=90?'good':'warn'],
   ['Variance recovered', fmt$(recovered), 'trailing 12 months', 'good'],
   ['Statements on hold', holds.length, 'of '+stmts.length+' — exceptions block payment', holds.length?'warn':'good'],
   ['Open vendor offers', k.open_deals, fmt$(k.open_deal_savings)+' at commit', 'good'],
   ['ATS crossref match', atsItems? Math.round(100*atsMatched/atsItems)+'%':'—', fmtN(atsMatched)+' of '+fmtN(atsItems)+' vendor items matched', ''],
   ['Store tasks', k.open_tasks, k.overdue_tasks+' overdue', Number(k.overdue_tasks)>0?'warn':'good'],
  ].map(x=>`<div class="kpi ${x[3]}"><div class="lbl">${x[0]}</div><div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  mkChart('ch-ovo-trend','bar',{labels:trend.map(r=>String(r.match_month).slice(0,7)),datasets:[
    {label:'Identified $',data:trend.map(r=>+r.variance_identified),backgroundColor:'#9fb0cc'},
    {label:'Recovered $',data:trend.map(r=>+r.variance_recovered),backgroundColor:'#1E9E5A'},
    {label:'Still open $',data:trend.map(r=>+r.variance_open),backgroundColor:'#C0392B'},
    {label:'Auto-clear %',type:'line',yAxisID:'y1',data:trend.map(r=>+r.auto_clear_pct),borderColor:'#2E5BFF',borderWidth:2,pointRadius:2,tension:.3}]},
    {scales:{y:{ticks:{callback:x=>'$'+fmtN(x)}},y1:{position:'right',min:80,max:100,grid:{drawOnChartArea:false},ticks:{callback:x=>x+'%'}}}});
  const ts=await runQ(`SELECT status, count(*) n FROM ${S}.task_board_v GROUP BY 1 ORDER BY n DESC`);
  mkChart('ch-ovo-tasks','bar',{labels:ts.map(r=>r.status),datasets:[{label:'Store tasks',data:ts.map(r=>+r.n),
    backgroundColor:ts.map(r=>({Done:'#1E9E5A',Overdue:'#C0392B',InProgress:'#2E5BFF',Open:'#9fb0cc'})[r.status]||'#9fb0cc')}]},
    {indexAxis:'y',plugins:{legend:{display:false}}});
  document.getElementById('ovo-tbl').innerHTML=table(stmts.slice(0,15),[
    {h:'Statement',f:r=>`<span class="mono" style="font-size:11px">${esc(r.master_statement_id)}</span><br><b>${esc(r.vendor_name.split(' ')[0])}</b>`},
    {h:'Inv',k:'invoice_count',num:1},{h:'Total',f:r=>fmt$(r.statement_total),num:1},
    {h:'Open exc',f:r=>+r.open_exceptions?`${r.open_exceptions} · ${fmt$(r.open_exception_amt)}`:'—',num:1},
    {h:'Due',f:r=>String(r.last_due).slice(0,10)},
    {h:'Status',f:r=>`<span class="chip ${r.recon_status==='Clear to pay'?'green':r.recon_status==='Pay less debit memos'?'blue':'red'}">${esc(r.recon_status)}</span>`}]);
},

async demand(){
  const TL=await runQ(`SELECT * FROM ${S}.demand_timeline_v`);
  const PO=await runQ(`SELECT * FROM ${S}.proposed_po_v`);
  const v=id=>document.getElementById(id).value;
  const chk=id=>document.getElementById(id).checked;
  const PAL=['#2E5BFF','#1F2A44','#7C4DBE','#C55A11','#1B9E9E','#8B6B23','#9fb0cc'];
  // ---------- timeline ----------
  const tlCats=uniq(TL.map(r=>r.category)).sort(), tlVens=uniq(TL.map(r=>r.vendor_name)).sort(),
        tlRegs=uniq(TL.map(r=>r.climate_zone)).sort(), tlStores=uniq(TL.map(r=>r.store_id)).sort();
  document.getElementById('tl-controls').innerHTML=`
   <div><label>X axis</label><select id="tl-axis"><option value="forecast_week">Demand week</option><option value="order_by_week">Order-by week</option></select></div>
   <div><label>Group by</label><select id="tl-group"><option value="category">Category</option><option value="brand">Brand</option><option value="vendor_name">Vendor</option><option value="store_id">Store</option><option value="climate_zone">Region</option></select></div>
   <div><label>Values</label><select id="tl-val"><option value="units">Units</option><option value="cost">Dollars (cost)</option><option value="retail">Dollars (retail)</option></select></div>
   <div><label>Category</label><select id="tl-cat"><option value="">All</option>${tlCats.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Vendor</label><select id="tl-ven"><option value="">All</option>${tlVens.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Region</label><select id="tl-reg"><option value="">All</option>${tlRegs.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Store</label><select id="tl-store"><option value="">All</option>${tlStores.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Weather layer</label><select id="tl-wx"><option value="on">Layered</option><option value="off">Hidden</option></select></div>`;
  function tlPick(r, kind){
    const val=v('tl-val');
    if(kind==='base') return val==='units'? +r.forecast_units : val==='cost'? +r.forecast_cost : +r.forecast_retail;
    return val==='units'? +r.weather_adj_units : val==='cost'? +r.weather_adj_cost : +r.weather_adj_retail;
  }
  function renderTL(){
    const axis=v('tl-axis'), grp=v('tl-group');
    const f=TL.filter(r=>(!v('tl-cat')||r.category===v('tl-cat'))&&(!v('tl-ven')||r.vendor_name===v('tl-ven'))
      &&(!v('tl-reg')||r.climate_zone===v('tl-reg'))&&(!v('tl-store')||r.store_id===v('tl-store')));
    const wkSet=uniq(f.map(r=>String(r[axis]).slice(0,10))).sort();
    const weeks=axis==='order_by_week'? wkSet.map(w=>w<'2026-07-14'?'MISSED (past)':w) : wkSet;
    const wkLabels=uniq(weeks);
    const totals={}; f.forEach(r=>{const g=r[grp]; totals[g]=(totals[g]||0)+tlPick(r,'base');});
    const top=Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0]);
    const wkKey=r=>{const w=String(r[axis]).slice(0,10); return axis==='order_by_week'&&w<'2026-07-14'?'MISSED (past)':w;};
    const ds=top.map((g,i)=>({label:g, backgroundColor:PAL[i%PAL.length], stack:'base',
      data:wkLabels.map(w=>+f.filter(r=>wkKey(r)===w&&r[grp]===g).reduce((a,r)=>a+tlPick(r,'base'),0).toFixed(0))}));
    const otherData=wkLabels.map(w=>+f.filter(r=>wkKey(r)===w&&!top.includes(r[grp])).reduce((a,r)=>a+tlPick(r,'base'),0).toFixed(0));
    if(otherData.some(x=>x>0)) ds.push({label:'Other', backgroundColor:'#dfe7f5', stack:'base', data:otherData});
    let wxNote='';
    if(v('tl-wx')==='on'){
      const react=wkLabels.map(w=>+f.filter(r=>wkKey(r)===w&&r.weather_reactable==='true').reduce((a,r)=>a+tlPick(r,'wx'),0).toFixed(0));
      const missed=wkLabels.map(w=>+f.filter(r=>wkKey(r)===w&&r.weather_reactable!=='true').reduce((a,r)=>a+tlPick(r,'wx'),0).toFixed(0));
      ds.push({label:'Weather — reactable', backgroundColor:'#1E9E5A', stack:'base', data:react});
      ds.push({label:'Weather — order window missed', backgroundColor:'#C0392B', stack:'base', data:missed});
      const rTot=react.reduce((a,b)=>a+b,0), mTot=missed.reduce((a,b)=>a+b,0);
      wxNote=` · Weather-triggered: <b style="color:var(--green)">${fmtN(rTot)} reactable</b> / <b style="color:var(--red)">${fmtN(mTot)} missed</b> — the case for planning at observed lead times`;
    }
    mkChart('ch-tl','bar',{labels:wkLabels,datasets:ds},
      {scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:x=>v('tl-val')==='units'?x:'$'+fmtN(x)}}},plugins:{legend:{labels:{boxWidth:11,font:{size:10}}}}});
    document.getElementById('tl-note').innerHTML=
      `<span>Axis: <b>${axis==='order_by_week'?'order-by week (demand shifted back by vendor lead time; MISSED = should already be on order)':'demand week'}</b>${wxNote}</span>`;
  }
  ['tl-axis','tl-group','tl-val','tl-cat','tl-ven','tl-reg','tl-store','tl-wx'].forEach(id=>document.getElementById(id).onchange=renderTL);
  renderTL();
  // ---------- matrix ----------
  document.getElementById('mx-controls').innerHTML=`
   <div><label>Values</label><select id="mx-val"><option value="units">Units</option><option value="retail">Dollars (retail)</option><option value="cost">Dollars (cost)</option></select></div>
   <div><label>Region</label><select id="mx-reg"><option value="">All regions</option>${tlRegs.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Store</label><select id="mx-store"><option value="">All stores</option>${tlStores.map(c=>`<option>${c}</option>`).join('')}</select></div>`;
  function renderMX(){
    const val=v('mx-val');
    const pick=r=> val==='units'? +r.forecast_units+ +r.weather_adj_units : val==='cost'? +r.forecast_cost+ +r.weather_adj_cost : +r.forecast_retail+ +r.weather_adj_retail;
    const f=TL.filter(r=>(!v('mx-reg')||r.climate_zone===v('mx-reg'))&&(!v('mx-store')||r.store_id===v('mx-store')));
    const weeks=uniq(f.map(r=>String(r.forecast_week).slice(0,10))).sort();
    const cats=uniq(f.map(r=>r.category)).sort();
    const cell={}, colMax={};
    weeks.forEach(w=>cats.forEach(c=>{
      const s=f.filter(r=>String(r.forecast_week).slice(0,10)===w&&r.category===c).reduce((a,r)=>a+pick(r),0);
      cell[w+'|'+c]=s; colMax[c]=Math.max(colMax[c]||0,s);
    }));
    const fmt=x=> val==='units'? fmtN(Math.round(x)) : fmt$(Math.round(x));
    const head='<th>Week</th>'+cats.map(c=>`<th>${c}</th>`).join('')+'<th>Total</th>';
    const body=weeks.map(w=>{
      const tds=cats.map(c=>{const x=cell[w+'|'+c]; const heat=colMax[c]?x/colMax[c]:0;
        return `<td class="num" style="background:rgba(46,91,255,${(heat*0.28).toFixed(3)})">${fmt(x)}</td>`;}).join('');
      const tot=cats.reduce((a,c)=>a+cell[w+'|'+c],0);
      return `<tr><td><b>${w}</b></td>${tds}<td class="num" style="font-weight:700">${fmt(tot)}</td></tr>`;
    }).join('');
    const totRow='<tr style="border-top:2px solid var(--navy)"><td><b>Total</b></td>'+cats.map(c=>{
      const t=weeks.reduce((a,w)=>a+cell[w+'|'+c],0); return `<td class="num" style="font-weight:700">${fmt(t)}</td>`;}).join('')+
      `<td class="num" style="font-weight:700">${fmt(weeks.reduce((a,w)=>a+cats.reduce((x,c)=>x+cell[w+'|'+c],0),0))}</td></tr>`;
    document.getElementById('mx-table').innerHTML=`<div class="tblwrap"><table><thead><tr>${head}</tr></thead><tbody>${body}${totRow}</tbody></table></div>`;
  }
  ['mx-val','mx-reg','mx-store'].forEach(id=>document.getElementById(id).onchange=renderMX);
  renderMX();
  // ---------- PO generator ----------
  const poVens=uniq(PO.map(r=>r.vendor_name)).sort();
  document.getElementById('po-controls').innerHTML=`
   <div><label>Horizon</label><select id="po-h"><option value="2">2 weeks</option><option value="4" selected>4 weeks</option><option value="6">6 weeks</option><option value="8">8 weeks</option></select></div>
   <div><label>Vendor</label><select id="po-ven"><option value="">All vendors</option>${poVens.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Region</label><select id="po-reg"><option value="">All regions</option>${tlRegs.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Weather demand</label><select id="po-wx"><option value="on">Included</option><option value="off">Excluded</option></select></div>
   <div style="align-self:flex-end"><button id="po-go" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer">Generate proposal</button></div>`;
  function genPO(){
    const h=v('po-h'), wx=v('po-wx')==='on';
    const lines=[];
    PO.forEach(r=>{
      if(v('po-ven')&&r.vendor_name!==v('po-ven')) return;
      if(v('po-reg')&&r.climate_zone!==v('po-reg')) return;
      const need=+r['fc_'+h+'wk'] + (wx? +r['wx_'+h+'wk'] : 0) + +r.safety_stock - +r.position;
      const qty=Math.max(0, Math.ceil(need));
      if(qty>0) lines.push({...r, qty, ext: +(qty*r.unit_cost).toFixed(2)});
    });
    const byVen={};
    lines.forEach(l=>{const k=l.vendor_name; byVen[k]=byVen[k]||{vendor:k,vendor_id:l.vendor_id,stores:new Set(),lines:0,units:0,cost:0,moq:l.moq_units,receipt:l.expected_receipt,note:l.tier_break_note};
      byVen[k].stores.add(l.store_id); byVen[k].lines++; byVen[k].units+=l.qty; byVen[k].cost+=l.ext;});
    const vens=Object.values(byVen).sort((a,b)=>b.cost-a.cost);
    const totCost=lines.reduce((a,l)=>a+l.ext,0), totUnits=lines.reduce((a,l)=>a+l.qty,0);
    const csvCols=['master_po','store_id','store_name','sku_id','brand','style_name','color','size','category','vendor_name','qty','unit_cost','ext_cost','position','safety_stock','forecast_'+h+'wk','weather_adj','lead_days_p50','expected_receipt','tier_break_note'];
    const csv=[csvCols.join(',')].concat(lines.map(l=>{
      const mpo='MPO-PROP-'+String(l.vendor_id).slice(1);
      return [mpo,l.store_id,`"${l.store_name}"`,`"${l.sku_id}"`,l.brand,`"${l.style_name}"`,`"${l.color}"`,`"${l.size}"`,`"${l.category}"`,`"${l.vendor_name}"`,l.qty,l.unit_cost,l.ext,l.position,l.safety_stock,l['fc_'+h+'wk'],wx?l['wx_'+h+'wk']:0,l.lead_days_p50,l.expected_receipt,`"${l.tier_break_note}"`].join(',');
    })).join('\n');
    const kpis=[['Proposed master POs',vens.length,'one per vendor'],['Lines',fmtN(lines.length),'store x SKU'],['Units',fmtN(totUnits),h+'-week horizon'+(wx?' + weather':'')],['Est. cost',fmt$(totCost),'at current costs']]
      .map(k=>`<div class="kpi"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
    const venTbl=table(vens.map(x=>({vendor:x.vendor,stores:x.stores.size,lines:x.lines,units:x.units,cost:x.cost,moq:x.moq,receipt:x.receipt,note:x.note,belowMoq:x.units<+x.moq})),[
      {h:'Proposed master PO',f:r=>`<span class="mono" style="font-size:11px">MPO-PROP-…</span> <b>${esc(r.vendor)}</b>`},
      {h:'Ship-to stores',k:'stores',num:1},{h:'Lines',k:'lines',num:1},{h:'Units',f:r=>fmtN(r.units),num:1},
      {h:'Est. cost',f:r=>fmt$(r.cost),num:1},
      {h:'MOQ check',f:r=>r.belowMoq?`<span class="chip red">Below MOQ (${r.moq})</span>`:'<span class="chip green">OK</span>'},
      {h:'Expected receipt',f:r=>String(r.receipt).slice(0,10)},
      {h:'Opportunity',f:r=>esc(r.note||'—')}]);
    const preview=table(lines.sort((a,b)=>b.ext-a.ext).slice(0,20),[
      {h:'Store',k:'store_id'},{h:'Item',f:r=>`<b>${esc(r.brand)}</b> ${esc(r.style_name)}<br><span style="color:var(--sub)">${esc(r.color)} · ${esc(r.size)}</span>`},
      {h:'Vendor',f:r=>esc(r.vendor_name.split(' ')[0])},{h:'Position',k:'position',num:1},
      {h:'Need ('+h+'wk)',f:r=>(+r['fc_'+h+'wk']+(wx?+r['wx_'+h+'wk']:0)+ +r.safety_stock).toFixed(1),num:1},
      {h:'Qty',f:r=>`<b>${r.qty}</b>`,num:1},{h:'Ext cost',f:r=>fmt$(r.ext),num:1}]);
    document.getElementById('po-out').innerHTML=`
      <div class="kpis">${kpis}</div>
      <h3 style="margin:6px 0 8px">Master PO roll-up</h3>${venTbl}
      <h3 style="margin:14px 0 8px">Largest lines (preview — export carries all ${fmtN(lines.length)})</h3>${preview}
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        <button id="po-dl" style="background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:12.5px;cursor:pointer">Download CSV</button>
        <button id="po-cp" style="background:#fff;color:var(--navy);border:1.5px solid var(--navy);border-radius:8px;padding:8px 16px;font-size:12.5px;cursor:pointer">Copy CSV</button>
        <span id="po-msg" style="align-self:center;font-size:11.5px;color:var(--sub)"></span></div>
      <textarea id="po-csv" style="display:none;width:100%;height:140px;margin-top:10px;font-family:Consolas,monospace;font-size:10.5px;border:1px solid #C9D6EC;border-radius:8px;padding:8px"></textarea>`;
    document.getElementById('po-dl').onclick=()=>{
      try{ const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a');
        a.href=URL.createObjectURL(blob); a.download='WW_proposed_POs_'+h+'wk_2026-07-14.csv'; a.click();
        document.getElementById('po-msg').textContent='Downloaded.';
      }catch(e){ const t=document.getElementById('po-csv'); t.style.display='block'; t.value=csv;
        document.getElementById('po-msg').textContent='Download blocked in this view — CSV shown below, select-all and copy.'; }
    };
    document.getElementById('po-cp').onclick=async()=>{
      try{ await navigator.clipboard.writeText(csv); document.getElementById('po-msg').textContent='Copied to clipboard.'; }
      catch(e){ const t=document.getElementById('po-csv'); t.style.display='block'; t.value=csv; t.select();
        document.getElementById('po-msg').textContent='Clipboard blocked — CSV shown below, select-all and copy.'; }
    };
  }
  document.getElementById('po-go').onclick=genPO;
  genPO();
  const toGen=document.getElementById('po-to-gen');
  if(toGen) toGen.onclick=e=>{ e.preventDefault(); show('pogen'); };
  // ---------- size overlay (existing) ----------
  const rows=await runQ(`SELECT * FROM ${S}.size_demand_v`);
  const ctrl=document.getElementById('sd-controls');
  const stores=uniq(rows.map(r=>r.store_id)).sort();
  const cats=uniq(rows.map(r=>r.category)).sort();
  ctrl.innerHTML=`
    <div><label>Store</label><select id="sd-store"><option value="">All stores</option>${stores.map(s=>`<option>${s}</option>`).join('')}</select></div>
    <div><label>Category</label><select id="sd-cat">${cats.map(c=>`<option ${c==='Tops'?'selected':''}>${c}</option>`).join('')}</select></div>
    <div><label>Brand</label><select id="sd-brand"></select></div>`;
  function brandOpts(){
    const cat=document.getElementById('sd-cat').value;
    const brands=uniq(rows.filter(r=>r.category===cat).map(r=>r.brand)).sort();
    document.getElementById('sd-brand').innerHTML='<option value="">All brands</option>'+brands.map(b=>`<option>${b}</option>`).join('');
  }
  function render(){
    const st=document.getElementById('sd-store').value, cat=document.getElementById('sd-cat').value, br=document.getElementById('sd-brand').value;
    const f=rows.filter(r=>r.category===cat&&(!st||r.store_id===st)&&(!br||r.brand===br));
    const agg={};
    f.forEach(r=>{
      const k=r.size; agg[k]=agg[k]||{a:0,f:0,share:null,meat:r.meat_size==='true'};
      agg[k].a+=+r.actual_weekly_units; agg[k].f+=+r.forecast_weekly_units;
      if(r.size_curve_share!=null) agg[k].share=+r.size_curve_share;
    });
    const sizes=Object.keys(agg).sort(sizeSort);
    const totA=sizes.reduce((s,k)=>s+agg[k].a,0);
    const curveScaled=sizes.map(k=>agg[k].share!=null?+(agg[k].share*totA).toFixed(2):null);
    mkChart('ch-size','bar',{labels:sizes,datasets:[
      {label:'Actual avg wk units',data:sizes.map(k=>+agg[k].a.toFixed(1)),backgroundColor:'#1F2A44',order:2},
      {label:'Forecast wk units',data:sizes.map(k=>+agg[k].f.toFixed(1)),backgroundColor:'#2E5BFF',order:2},
      {label:'Size-curve expected (scaled)',data:curveScaled,type:'line',borderColor:'#C55A11',borderWidth:2,pointRadius:3,pointBackgroundColor:'#C55A11',tension:.25,order:1}]},
      {scales:{x:{ticks:{color:c=>agg[sizes[c.index]]&&agg[sizes[c.index]].meat?'#C0392B':'#5a6880',font:{weight:'bold'}}},y:{title:{display:true,text:'units / week'}}}});
    const over=sizes.filter(k=>agg[k].f>0&&agg[k].a/Math.max(agg[k].f,.01)>1.25);
    const under=sizes.filter(k=>agg[k].f>0&&agg[k].a/Math.max(agg[k].f,.01)<0.75);
    document.getElementById('sd-note').innerHTML=
      `<span><span class="dot" style="background:#1F2A44"></span>Actual</span><span><span class="dot" style="background:#2E5BFF"></span>Forecast</span><span><span class="dot" style="background:#C55A11"></span>Curve expectation</span>`+
      (over.length?` · <b>Selling over forecast:</b> ${over.join(', ')}`:'')+
      (under.length?` · <b>Under forecast:</b> ${under.join(', ')}`:'')+
      ` · scope: ${st||'all stores'} / ${cat}${br?' / '+br:''}`;
  }
  document.getElementById('sd-cat').onchange=()=>{brandOpts();render();};
  document.getElementById('sd-store').onchange=render;
  document.getElementById('sd-brand').onchange=render;
  brandOpts(); render();
},

async wxopp(){
  const day0=Date.parse(ANCHOR+'T00:00:00Z');
  const daysOut=d=>Math.round((Date.parse(String(d).slice(0,10)+'T00:00:00Z')-day0)/86400000);
  function bandOf(d){
    if(d<=3) return 'now';
    if(d<=10) return 'skill';
    if(d<=14) return 'watch';
    return 'climate';
  }
  const BANDS={
    now:{lo:-2,hi:3,label:'Nowcast 0–3d', hint:'Too late to buy from a vendor. Transfer only.'},
    skill:{lo:4,hi:10,label:'Skill window 4–10d', hint:'The commercial window: skillful forecast and still time to move goods.'},
    watch:{lo:11,hi:14,label:'Degrading 11–14d', hint:'Signal is fading. Watch lists, not event POs.'},
    climate:{lo:15,hi:60,label:'Climatology 15d+', hint:'Seasonal shape. Do not raise a storm PO this far out.'},
  };
  let TL=[], V=[], RQ=[];
  try{
    TL=await runQ(`SELECT * FROM ${S}.demand_timeline_v`);
    V=await runQ(`SELECT * FROM ${S}.store_variance_v`);
    RQ=await runQ(`SELECT store_id, action, days_to_stockout, brand, style_name FROM ${S}.replen_queue_v`);
  }catch(e){
    document.getElementById('wx-kpis').insertAdjacentHTML('beforebegin',
      '<div class="warnbox">Warehouse not reachable — showing a sample skill-window board so you can walk the plays.</div>');
    TL=[
      {forecast_week:'2026-07-14',order_by_week:'2026-06-23',store_id:'S01',store_name:'Fargo',climate_zone:'Cold',category:'Outerwear',brand:'Carhartt',vendor_name:'Carhartt',lead_days_p50:'21',forecast_units:'40',weather_adj_units:'18',weather_adj_cost:'1400',weather_reactable:'false'},
      {forecast_week:'2026-07-21',order_by_week:'2026-06-30',store_id:'S01',store_name:'Fargo',climate_zone:'Cold',category:'Outerwear',brand:'Carhartt',vendor_name:'Carhartt',lead_days_p50:'21',forecast_units:'38',weather_adj_units:'22',weather_adj_cost:'1710',weather_reactable:'false'},
      {forecast_week:'2026-07-21',order_by_week:'2026-07-14',store_id:'S04',store_name:'Duluth',climate_zone:'Cold',category:'Footwear',brand:'Wolverine',vendor_name:'Wolverine',lead_days_p50:'14',forecast_units:'20',weather_adj_units:'14',weather_adj_cost:'1340',weather_reactable:'true'},
      {forecast_week:'2026-07-21',order_by_week:'2026-07-16',store_id:'S08',store_name:'Bismarck',climate_zone:'Cold',category:'Outerwear',brand:'Helly Hansen',vendor_name:'Helly Hansen',lead_days_p50:'12',forecast_units:'16',weather_adj_units:'19',weather_adj_cost:'1210',weather_reactable:'true'},
      {forecast_week:'2026-07-28',order_by_week:'2026-07-07',store_id:'S12',store_name:'Des Moines',climate_zone:'Midwest',category:'Outerwear',brand:'Carhartt',vendor_name:'Carhartt',lead_days_p50:'21',forecast_units:'30',weather_adj_units:'6',weather_adj_cost:'460',weather_reactable:'false'},
      {forecast_week:'2026-08-04',order_by_week:'2026-07-14',store_id:'S22',store_name:'Sioux Falls',climate_zone:'Midwest',category:'Tops',brand:'Red Kap',vendor_name:'Red Kap',lead_days_p50:'21',forecast_units:'44',weather_adj_units:'1',weather_adj_cost:'22',weather_reactable:'true'},
    ];
    V=[
      {store_id:'S01',store_name:'Fargo',latitude:'46.88',longitude:'-96.79',category:'Outerwear',brand:'Carhartt',size:'L',outs:'4',meat_outs:'3',lost_sales:'1800',positions:'12',actual_units:'80',expected_units:'70'},
      {store_id:'S04',store_name:'Duluth',latitude:'46.79',longitude:'-92.10',category:'Footwear',brand:'Wolverine',size:'10',outs:'3',meat_outs:'2',lost_sales:'960',positions:'8',actual_units:'40',expected_units:'38'},
      {store_id:'S08',store_name:'Bismarck',latitude:'46.81',longitude:'-100.78',category:'Outerwear',brand:'Helly Hansen',size:'XL',outs:'5',meat_outs:'4',lost_sales:'2100',positions:'6',actual_units:'22',expected_units:'28'},
      {store_id:'S12',store_name:'Des Moines',latitude:'41.59',longitude:'-93.62',category:'Outerwear',brand:'Carhartt',size:'M',outs:'0',meat_outs:'0',lost_sales:'0',positions:'40',actual_units:'90',expected_units:'88'},
      {store_id:'S22',store_name:'Sioux Falls',latitude:'43.54',longitude:'-96.73',category:'Tops',brand:'Red Kap',size:'L',outs:'1',meat_outs:'0',lost_sales:'80',positions:'28',actual_units:'50',expected_units:'48'},
    ];
    RQ=[{store_id:'S01',action:'ExpediteCheck',days_to_stockout:'4',brand:'Carhartt',style_name:'Jacket'},
        {store_id:'S08',action:'TransferFirst',days_to_stockout:'6',brand:'Helly Hansen',style_name:'Rain Jacket'}];
  }
  TL.forEach(r=>{ r._d=daysOut(r.forecast_week); r._band=bandOf(r._d); r.wx=+r.weather_adj_units||0; r.fc=+r.forecast_units||0; r.lead=+r.lead_days_p50||21; });
  const catWx={};
  TL.forEach(r=>{ const k=r.category; catWx[k]=catWx[k]||{cat:k,wx:0,fc:0}; catWx[k].wx+=r.wx; catWx[k].fc+=r.fc; });
  const sensitive=Object.values(catWx).map(c=>({...c, share:c.fc?c.wx/c.fc:0})).sort((a,b)=>b.share-a.share);
  const defaultCats=new Set(sensitive.filter(c=>c.share>=0.08 || /rain|outer|foot|boot|weather|wet/i.test(c.cat)).map(c=>c.cat));
  if(!defaultCats.size) sensitive.slice(0,3).forEach(c=>defaultCats.add(c.cat));

  const inv={};
  V.forEach(r=>{
    const k=r.store_id+'|'+r.category;
    const o=inv[k]=inv[k]||{store_id:r.store_id,store_name:r.store_name,lat:+r.latitude,lon:+r.longitude,category:r.category,outs:0,meat:0,lost:0,pos:0};
    o.outs+=+r.outs||0; o.meat+=+r.meat_outs||0; o.lost+=+r.lost_sales||0; o.pos+=+r.positions||0;
  });
  const loc={};
  V.forEach(r=>{ loc[r.store_id]=loc[r.store_id]||{store_id:r.store_id,store_name:r.store_name,latitude:r.latitude,longitude:r.longitude}; });

  let windowId='skill', playTab='all', selStore=null;
  document.getElementById('wx-ribbon').innerHTML=Object.entries(BANDS).map(([id,b])=>
    `<button type="button" class="wx-seg ${id}" data-w="${id}"><b>${esc(b.label)}</b><span>${esc(b.hint)}</span></button>`).join('');
  document.getElementById('wx-controls').innerHTML=`
    <div><label>Categories</label><select id="wx-cat"><option value="">Weather-sensitive (auto)</option>${sensitive.map(c=>`<option value="${esc(c.cat)}">${esc(c.cat)} · ${Math.round(c.share*100)}% wx share</option>`).join('')}</select></div>
    <div><label>Region</label><select id="wx-reg"><option value="">All zones</option>${uniq(TL.map(r=>r.climate_zone)).sort().map(z=>`<option>${esc(z)}</option>`).join('')}</select></div>`;

  function inWindow(r){
    const b=BANDS[windowId];
    return r._d>=b.lo && r._d<=b.hi;
  }
  function catOk(r){
    const c=document.getElementById('wx-cat').value;
    if(c) return r.category===c;
    return defaultCats.has(r.category);
  }
  function rowsTL(){
    const z=document.getElementById('wx-reg').value;
    return TL.filter(r=>inWindow(r)&&catOk(r)&&(!z||r.climate_zone===z));
  }
  function plays(){
    const f=rowsTL();
    const g={};
    f.forEach(r=>{
      const k=r.store_id+'|'+r.category;
      const o=g[k]=g[k]||{id:k,store_id:r.store_id,store_name:r.store_name,zone:r.climate_zone,category:r.category,
        wx:0,fc:0,cost:0,lead:r.lead,dMin:99,react:0,n:0};
      o.wx+=r.wx; o.fc+=r.fc; o.cost+=+r.weather_adj_cost||0; o.n++;
      o.dMin=Math.min(o.dMin,r._d); o.lead=Math.max(o.lead,r.lead);
      if(r.weather_reactable==='true'||r.weather_reactable===true) o.react++;
    });
    const list=Object.values(g).map(p=>{
      const i=inv[p.store_id+'|'+p.category]||{outs:0,meat:0,lost:0,pos:0,lat:null,lon:null};
      p.outs=i.outs; p.meat=i.meat; p.lost=i.lost; p.pos=i.pos;
      p.lat=i.lat; p.lon=i.lon;
      p.cover=p.fc>0? +(p.pos/(p.fc/Math.max(p.n,1))).toFixed(1) : 99;
      const sisters=Object.values(g).filter(s=>s.category===p.category && s.store_id!==p.store_id);
      const donor=sisters.sort((a,b)=> (inv[b.store_id+'|'+b.category]?.pos||0)-(inv[a.store_id+'|'+a.category]?.pos||0))[0];
      p.donor=donor? donor.store_id+' '+donor.store_name : '';
      const leadFits=p.lead<=p.dMin+2;
      const short=p.meat>0 || p.outs>=2 || p.cover<2;
      const wxHit=p.wx>=8;
      if(windowId==='climate' && wxHit) { p.play='Watch'; p.why='Beyond skill — do not event-buy climatology'; }
      else if(windowId==='now' && short && wxHit){ p.play='Too late'; p.why=p.donor? 'Vendor clock missed — transfer from '+p.donor : 'Event is inside 3 days and we are already short'; }
      else if(short && wxHit && !leadFits){ p.play='Transfer'; p.why='Observed lead '+p.lead+'d > event in '+p.dMin+'d'+(p.donor? ' · donor '+p.donor:''); }
      else if(short && wxHit && leadFits){ p.play='Expedite'; p.why='Lead still fits the skill window — event-buy / expedite, not a seasonal raise'; }
      else if(wxHit && !short){ p.play='Watch'; p.why='Weather lifts demand but cover is healthy — let it sell, do not pile on'; }
      else { p.play='Watch'; p.why='Signal below action threshold in this window'; }
      const rq=RQ.filter(x=>x.store_id===p.store_id);
      if(rq.some(x=>x.action==='ExpediteCheck')) p.queue='Expedite already on replen queue';
      else if(rq.some(x=>x.action==='TransferFirst')) p.queue='Transfer already suggested';
      else p.queue='';
      return p;
    }).sort((a,b)=> (b.meat-a.meat)|| (b.wx-a.wx));
    return list;
  }

  function paintRibbon(){
    document.querySelectorAll('#wx-ribbon .wx-seg').forEach(b=>{
      b.classList.toggle('on', b.dataset.w===windowId);
    });
  }
  function kpis(list){
    const act=list.filter(p=>p.play==='Transfer'||p.play==='Expedite'||p.play==='Too late');
    const wxU=list.reduce((a,p)=>a+p.wx,0), cost=list.reduce((a,p)=>a+p.cost,0);
    const meat=list.reduce((a,p)=>a+p.meat,0);
    document.getElementById('wx-kpis').innerHTML=[
      ['Window', BANDS[windowId].label.replace(/ .*/,''), BANDS[windowId].hint, ''],
      ['Weather units', fmtN(Math.round(wxU)), 'in weather-sensitive categories', wxU?'good':''],
      ['At stores already short', fmtN(act.length), meat+' meat-size breaks in the hit', meat?'warn':''],
      ['Lift at risk', fmt$(Math.round(cost)), 'weather $ at those locations', cost?'warn':''],
      ['Too late to buy', fmtN(list.filter(p=>p.play==='Too late').length), 'nowcast + shortage — transfer or miss', ''],
    ].map(x=>`<div class="kpi ${x[3]}"><div class="lbl">${x[0]}</div><div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  }
  function renderMap(list){
    const by={};
    list.forEach(p=>{
      const loc1=loc[p.store_id]; if(!loc1) return;
      const o=by[p.store_id]=by[p.store_id]||{...loc1,wx:0,meat:0,plays:[]};
      o.wx+=p.wx; o.meat+=p.meat; o.plays.push(p);
    });
    const stores=Object.values(by);
    const host=document.getElementById('wx-map');
    if(!stores.length){ host.innerHTML='<div class="loading">No stores in this window.</div>'; return; }
    host.innerHTML=mapSVG2(stores, s=>s.wx, 'hot', selStore);
    // mapSVG2 mode 'hot' isn't defined - uses default blue. Let me use 'bad' for meat overlay... 
    // Actually I used 'hot' which falls through to blue. Better color by meat using custom.
    document.getElementById('wx-map-legend').innerHTML=
      `<span><span class="dot" style="background:#2E5BFF"></span>Size = weather units in window</span>
       <span><span class="dot" style="background:#C0392B"></span>Click a store — red meat breaks drive Transfer / Expedite / Too late</span>`;
    const tip=document.getElementById('wxtip');
    host.querySelectorAll('circle.store').forEach(c=>{
      const s=stores[+c.dataset.i];
      if(s.meat>0){ c.setAttribute('fill','#C0392B'); c.setAttribute('stroke','#C0392B'); }
      c.addEventListener('mousemove',ev=>{
        const box=host.getBoundingClientRect();
        tip.style.display='block'; tip.style.left=(ev.clientX-box.left+14)+'px'; tip.style.top=(ev.clientY-box.top-10)+'px';
        tip.innerHTML=`<b>${s.store_id} — ${esc(s.store_name)}</b><br>${fmtN(Math.round(s.wx))} wx units · ${s.meat} meat breaks`;
      });
      c.addEventListener('mouseleave',()=>tip.style.display='none');
      c.addEventListener('click',()=>{ selStore=s.store_id; render(); });
    });
  }
  function renderSide(list){
    const el=document.getElementById('wx-side');
    if(!selStore){ el.innerHTML='<h3>Store playbook</h3><div class="loading">{ SELECT A STORE }</div>'; return; }
    const mine=list.filter(p=>p.store_id===selStore);
    const name=(mine[0]||{}).store_name||selStore;
    if(!mine.length){ el.innerHTML=`<h3>${esc(selStore)}</h3><p class="hint">No weather-sensitive rows in this window.</p>`; return; }
    el.innerHTML=`<h3>${esc(selStore)} — ${esc(name)}</h3>
      <div class="hint">Plays in the ${esc(BANDS[windowId].label)} only. Sister-store donors appear when lead cannot make the event.</div>`+
      table(mine,[
        {h:'Category',k:'category'},
        {h:'Wx units',f:r=>fmtN(Math.round(r.wx)),num:1},
        {h:'Meat',k:'meat',num:1},
        {h:'Play',f:r=>statusChip(r.play)},
        {h:'Why',f:r=>`<span style="font-size:11.5px;color:var(--sub)">${esc(r.why)}</span>`},
      ])+
      `<div class="pg-actions" style="margin-top:10px;margin-bottom:0">
        <button class="btn ghost" onclick="show('replen')">Replenishment</button>
        <button class="btn" onclick="show('pogen')">PO Generator</button>
      </div>`;
  }
  function renderTbl(list){
    const labels=[['all','All'],['Expedite','Expedite'],['Transfer','Transfer'],['Too late','Too late'],['Watch','Watch']];
    const counts={all:list.length};
    list.forEach(p=>counts[p.play]=(counts[p.play]||0)+1);
    document.getElementById('wx-tabs').innerHTML=labels.map(([id,lab])=>
      `<button data-t="${id}" class="${playTab===id?'active':''}">${lab} <b>${counts[id]||0}</b></button>`).join('');
    document.querySelectorAll('#wx-tabs button').forEach(b=>b.onclick=()=>{ playTab=b.dataset.t; render(); });
    const vis=playTab==='all'?list:list.filter(p=>p.play===playTab);
    document.getElementById('wx-tbl').innerHTML=table(vis.slice(0,80),[
      {h:'Store',f:r=>`<b>${esc(r.store_id)}</b><br><span style="color:var(--sub)">${esc(r.store_name)} · ${esc(r.zone)}</span>`},
      {h:'Category',k:'category'},
      {h:'Wx units',f:r=>fmtN(Math.round(r.wx)),num:1},
      {h:'Meat breaks',k:'meat',num:1},
      {h:'Days to event',k:'dMin',num:1},
      {h:'Vendor lead',k:'lead',num:1},
      {h:'Play',f:r=>statusChip(r.play)},
      {h:'Why / donor',f:r=>`<span style="font-size:11.5px">${esc(r.why)}</span>${r.queue?'<br><span style="color:var(--purple);font-size:11px">'+esc(r.queue)+'</span>':''}`},
    ]);
  }
  function renderCharts(){
    const byW={};
    TL.filter(r=>catOk(r)&&( !document.getElementById('wx-reg').value || r.climate_zone===document.getElementById('wx-reg').value))
      .forEach(r=>{
        const w=String(r.forecast_week).slice(0,10);
        byW[w]=byW[w]||{w,d:r._d,skill:0,watch:0,climate:0,missed:0};
        const react=r.weather_reactable==='true'||r.weather_reactable===true;
        if(!react) byW[w].missed+=r.wx;
        else if(r._band==='skill'||r._band==='now') byW[w].skill+=r.wx;
        else if(r._band==='watch') byW[w].watch+=r.wx;
        else byW[w].climate+=r.wx;
      });
    const weeks=Object.values(byW).sort((a,b)=>a.w.localeCompare(b.w)).slice(0,12);
    mkChart('ch-wx-weeks','bar',{labels:weeks.map(w=>w.w.slice(5)+`  D+${w.d}`),datasets:[
      {label:'Skill / nowcast (reactable)',data:weeks.map(w=>+w.skill.toFixed(0)),backgroundColor:'#1E9E5A',stack:'wx'},
      {label:'Degrading 11–14d',data:weeks.map(w=>+w.watch.toFixed(0)),backgroundColor:'#C55A11',stack:'wx'},
      {label:'Climatology 15d+',data:weeks.map(w=>+w.climate.toFixed(0)),backgroundColor:'#9fb0cc',stack:'wx'},
      {label:'Missed order-by (lead already passed)',data:weeks.map(w=>+w.missed.toFixed(0)),backgroundColor:'#C0392B',stack:'wx'},
    ]},{scales:{x:{stacked:true},y:{stacked:true,title:{display:true,text:'weather-adj units'}}},plugins:{legend:{labels:{boxWidth:10,font:{size:10}}}}});
    const cats=sensitive.slice(0,8);
    mkChart('ch-wx-cats','bar',{labels:cats.map(c=>c.cat),datasets:[
      {label:'Base forecast',data:cats.map(c=>+c.fc.toFixed(0)),backgroundColor:'#9fb0cc'},
      {label:'Weather lift',data:cats.map(c=>+c.wx.toFixed(0)),backgroundColor:'#2E5BFF'},
    ]},{indexAxis:'y',plugins:{legend:{labels:{boxWidth:10}}}});
  }
  function render(){
    paintRibbon();
    const list=plays();
    kpis(list);
    renderMap(list);
    renderSide(list);
    renderTbl(list);
    renderCharts();
  }
  document.querySelectorAll('#wx-ribbon .wx-seg').forEach(b=>b.onclick=()=>{ windowId=b.dataset.w; playTab='all'; render(); });
  document.getElementById('wx-cat').onchange=()=>{ selStore=null; render(); };
  document.getElementById('wx-reg').onchange=()=>{ selStore=null; render(); };
  render();
},

async replen(){
  const q=await runQ(`SELECT action, count(*) n FROM ${S}.replen_queue_v GROUP BY 1 ORDER BY n DESC`);
  document.getElementById('rep-kpis').innerHTML=q.map(r=>`<div class="kpi"><div class="lbl">${esc(r.action)}</div><div class="val">${fmtN(r.n)}</div><div class="sub">in current queue</div></div>`).join('');
  // ----- map -----
  const V=await runQ(`SELECT * FROM ${S}.store_variance_v`);
  const ctrl=document.getElementById('map-controls');
  const cats=uniq(V.map(r=>r.category)).sort(), brands=uniq(V.map(r=>r.brand)).sort(), sizes=uniq(V.map(r=>r.size)).sort(sizeSort);
  ctrl.innerHTML=`
   <div><label>Metric</label><select id="mp-metric">
     <option value="var">Sales vs plan variance %</option><option value="outs">Stockout positions</option>
     <option value="meat">Meat-size breaks</option><option value="lost">Lost sales $</option></select></div>
   <div><label>Category</label><select id="mp-cat"><option value="">All</option>${cats.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Brand</label><select id="mp-brand"><option value="">All</option>${brands.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Size</label><select id="mp-size"><option value="">All</option>${sizes.map(c=>`<option>${c}</option>`).join('')}</select></div>
   <div><label>Break down by</label><select id="mp-dim"><option value="category">Category</option><option value="brand">Brand</option><option value="size">Size</option></select></div>`;
  let selStore=null;
  function filt(){ const c=v('mp-cat'),b=v('mp-brand'),s=v('mp-size');
    return V.filter(r=>(!c||r.category===c)&&(!b||r.brand===b)&&(!s||r.size===s)); }
  function v(id){return document.getElementById(id).value;}
  function aggStores(rows){
    const g={};
    rows.forEach(r=>{ const k=r.store_id;
      g[k]=g[k]||{store_id:k,store_name:r.store_name,latitude:r.latitude,longitude:r.longitude,a:0,e:0,outs:0,meat:0,lost:0};
      g[k].a+=+r.actual_units; g[k].e+=+r.expected_units; g[k].outs+=+r.outs; g[k].meat+=+r.meat_outs; g[k].lost+=+r.lost_sales; });
    return Object.values(g);
  }
  function metricVal(s){ const m=v('mp-metric');
    if(m==='var') return s.e>0? +(100*(s.a-s.e)/s.e).toFixed(1) : 0;
    if(m==='outs') return s.outs; if(m==='meat') return s.meat; return Math.round(s.lost); }
  function metricFmt(x){ const m=v('mp-metric'); return m==='var'?(x>0?'+':'')+x+'%' : m==='lost'?fmt$(x) : fmtN(x); }
  function renderMap(){
    const stores=aggStores(filt());
    document.getElementById('svgmap').innerHTML=mapSVG(stores, v('mp-metric'), metricVal, selStore);
    const m=v('mp-metric');
    document.getElementById('map-legend').innerHTML= m==='var'
      ? `<span><span class="dot" style="background:#1E9E5A"></span>Selling over plan</span><span><span class="dot" style="background:#C0392B"></span>Selling under plan</span><span>Scope: ${v('mp-cat')||'all categories'}${v('mp-brand')?' / '+v('mp-brand'):''}${v('mp-size')?' / size '+v('mp-size'):''} · last 8 weeks</span>`
      : `<span><span class="dot" style="background:#C0392B"></span>Higher = worse</span><span>Scope: ${v('mp-cat')||'all categories'}${v('mp-brand')?' / '+v('mp-brand'):''}${v('mp-size')?' / size '+v('mp-size'):''}</span>`;
    const tip=document.getElementById('maptip');
    document.querySelectorAll('#svgmap circle.store').forEach(c=>{
      const s=stores[+c.dataset.i];
      c.addEventListener('mousemove',ev=>{
        tip.style.display='block';
        const host=document.getElementById('svgmap').getBoundingClientRect();
        tip.style.left=(ev.clientX-host.left+14)+'px'; tip.style.top=(ev.clientY-host.top-10)+'px';
        tip.innerHTML=`<b>${s.store_id} — ${esc(s.store_name)}</b><br>${metricFmt(metricVal(s))} · ${fmtN(s.a)} units actual vs ${fmtN(Math.round(s.e))} plan<br>${s.outs} outs · ${s.meat} meat breaks · ${fmt$(s.lost)} lost`;
      });
      c.addEventListener('mouseleave',()=>tip.style.display='none');
      c.addEventListener('click',()=>{ selStore=s.store_id; renderMap(); renderSide(); });
    });
  }
  function renderSide(){
    const side=document.getElementById('map-side');
    if(!selStore){ side.innerHTML='<div class="loading">{ SELECT A STORE }</div>'; return; }
    const dim=v('mp-dim');
    const rows=filt().filter(r=>r.store_id===selStore);
    const g={};
    rows.forEach(r=>{ const k=r[dim]; g[k]=g[k]||{a:0,e:0,outs:0,meat:0,lost:0};
      g[k].a+=+r.actual_units; g[k].e+=+r.expected_units; g[k].outs+=+r.outs; g[k].meat+=+r.meat_outs; g[k].lost+=+r.lost_sales; });
    const m=v('mp-metric');
    let items=Object.entries(g).map(([k,x])=>({k, val: m==='var'?(x.e>0?100*(x.a-x.e)/x.e:0): m==='outs'?x.outs: m==='meat'?x.meat: x.lost, x}));
    items=items.filter(i=>i.x.e>0.5||i.val!==0);
    items.sort((p,q)=>m==='var'? p.val-q.val : q.val-p.val);
    if(dim==='size') items.sort((p,q)=>sizeSort(p.k,q.k));
    const top=items.slice(0,14);
    const name=(aggStores(rows)[0]||{}).store_name||selStore;
    side.innerHTML=`<h3 style="margin-bottom:8px">${selStore} — ${esc(name)} · by ${dim}</h3><div class="chartbox tall"><canvas id="ch-mapside"></canvas></div>`;
    mkChart('ch-mapside','bar',{labels:top.map(i=>i.k),datasets:[{label:m==='var'?'Variance % vs plan': m==='lost'?'Lost sales $':'Count',
      data:top.map(i=>+i.val.toFixed(1)),
      backgroundColor:top.map(i=> m==='var' ? (i.val<0?'#C0392B':'#1E9E5A') : '#2E5BFF')}]},
      {indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{callback:x=> m==='var'?x+'%': m==='lost'?'$'+fmtN(x):x}}}});
  }
  ['mp-metric','mp-cat','mp-brand','mp-size'].forEach(id=>document.getElementById(id).onchange=()=>{renderMap();renderSide();});
  document.getElementById('mp-dim').onchange=renderSide;
  renderMap();
  // ----- lead time -----
  const LT=await runQ(`SELECT * FROM ${S}.lead_time_variance_v`);
  const vendors=uniq(LT.map(r=>r.vendor_name)).sort();
  const pal=['#2E5BFF','#C0392B','#1E9E5A','#C55A11','#7C4DBE','#1B9E9E','#8B6B23'];
  const vcol=Object.fromEntries(vendors.map((v,i)=>[v,pal[i%pal.length]]));
  const dsets=vendors.map(v=>({label:v.split(' ')[0],
    data:LT.filter(r=>r.vendor_name===v).map(r=>({x:Date.parse(r.requested_ship), y:+r.variance_days})),
    backgroundColor:vcol[v], pointRadius:3, showLine:false}));
  const xs=LT.map(r=>Date.parse(r.requested_ship));
  dsets.push({label:'quoted (0)',type:'line',data:[{x:Math.min(...xs),y:0},{x:Math.max(...xs),y:0}],borderColor:'#1F2A44',borderDash:[6,4],borderWidth:1.5,pointRadius:0});
  mkChart('ch-lt-scatter','scatter',{datasets:dsets},
    {scales:{x:{type:'linear',ticks:{maxTicksLimit:8,callback:v=>new Date(v).toISOString().slice(0,10)}},
             y:{title:{display:true,text:'days vs quoted lead'}}},
     plugins:{legend:{labels:{boxWidth:10,font:{size:10}}}}});
  function pct(arr,p){ const a=[...arr].sort((x,y)=>x-y); return a.length?a[Math.min(a.length-1,Math.floor(p*a.length))]:0; }
  const vs=vendors.map(v=>{ const rows=LT.filter(r=>r.vendor_name===v);
    return {v, quoted:+rows[0].quoted_lead_days, p50:pct(rows.map(r=>+r.actual_lead_days),.5), p90:pct(rows.map(r=>+r.actual_lead_days),.9), n:rows.length}; });
  vs.sort((a,b)=>(b.p50-b.quoted)-(a.p50-a.quoted));
  mkChart('ch-lt-vendor','bar',{labels:vs.map(x=>x.v.split(' ')[0]+` (${x.n})`),datasets:[
    {label:'Quoted lead (planning basis today)',data:vs.map(x=>x.quoted),backgroundColor:'#9fb0cc'},
    {label:'Actual P50',data:vs.map(x=>x.p50),backgroundColor:'#2E5BFF'},
    {label:'Actual P90',data:vs.map(x=>x.p90),backgroundColor:'#C0392B'}]},
    {scales:{y:{title:{display:true,text:'days order → receipt'}}}});
  // ----- existing: size runs + queue -----
  const runs=await runQ(`SELECT store_id, sum(CASE WHEN run_status='MeatBreak' THEN 1 ELSE 0 END) meat, sum(CASE WHEN run_status='FringeBreak' THEN 1 ELSE 0 END) fringe, sum(CASE WHEN run_status='Intact' THEN 1 ELSE 0 END) intact FROM ${S}.size_run_health_v GROUP BY 1 ORDER BY 1`);
  mkChart('ch-runs','bar',{labels:runs.map(r=>r.store_id),datasets:[
    {label:'Meat break',data:runs.map(r=>+r.meat),backgroundColor:'#C0392B'},
    {label:'Fringe break',data:runs.map(r=>+r.fringe),backgroundColor:'#C55A11'},
    {label:'Intact',data:runs.map(r=>+r.intact),backgroundColor:'#1E9E5A'}]},
    {scales:{x:{stacked:true},y:{stacked:true}}});
  const rows=await runQ(`SELECT * FROM ${S}.replen_queue_v ORDER BY days_to_stockout LIMIT 25`);
  document.getElementById('rep-tbl').innerHTML=table(rows,[
    {h:'Store',k:'store_id'},{h:'Item',f:r=>`<b>${esc(r.brand)}</b> ${esc(r.style_name)}<br><span style="color:var(--sub)">${esc(r.color)} · ${esc(r.size)}</span>`},
    {h:'Action',f:r=>statusChip(r.action)},{h:'Qty',k:'suggested_qty',num:1},
    {h:'Stockout',f:r=>`${String(r.proj_stockout_date).slice(0,10)}<br><span style="color:var(--sub)">${r.days_to_stockout}d</span>`},
    {h:'Note',f:r=>esc(r.tier_break_note||r.reason)},{h:'Status',f:r=>statusChip(r.status)}]);
},

async pogen(){
  let PO=[];
  try{ PO=await runQ(`SELECT * FROM ${S}.proposed_po_v`); }
  catch(e){
    const demo=(store,name,zone,ven,vid,brand,style,size,pos,fc4,fc2,wx4,cost,moq,note)=>({
      store_id:store, store_name:name, climate_zone:zone, sku_id:brand+'-'+style+'-'+size, brand, style_name:style, color:'Black', size,
      category:'Tops', vendor_id:vid, vendor_name:ven, unit_cost:String(cost), position:String(pos), safety_stock:'2',
      fc_2wk:String(fc2), fc_4wk:String(fc4), fc_6wk:String(fc4*1.4), fc_8wk:String(fc4*1.8),
      wx_2wk:String(Math.round(wx4/2)), wx_4wk:String(wx4), wx_6wk:String(wx4), wx_8wk:String(wx4),
      lead_days_p50:'21', moq_units:String(moq), expected_receipt:'2026-08-04', tier_break_note:note||''
    });
    PO=[
      demo('S01','Fargo','Cold','Carhartt','V001','Carhartt','Dungaree Jacket','M',4,18,10,2,78,288,'Consolidate to 288-unit tier (OPP-2026-011)'),
      demo('S01','Fargo','Cold','Carhartt','V001','Carhartt','Dungaree Jacket','L',2,22,12,2,78,288,''),
      demo('S12','Des Moines','Midwest','Carhartt','V001','Carhartt','Work Pant','32x32',40,8,3,0,42,288,''),
      demo('S04','Duluth','Cold','Wolverine','V002','Wolverine','Steel Toe','10',3,14,8,1,96,48,''),
      demo('S04','Duluth','Cold','Wolverine','V002','Wolverine','Steel Toe','11',1,11,6,1,96,48,''),
      demo('S22','Sioux Falls','Midwest','Red Kap','V008','Red Kap','Work Shirt','L',18,6,2,0,22,24,''),
      demo('S08','Bismarck','Cold','Helly Hansen','V012','Helly Hansen','Rain Jacket','XL',6,9,3,12,64,12,'Preseason book pricing (OPP-2026-013)'),
      demo('S18','Rochester','Midwest','Dickies','V006','Dickies','Coverall','L',2,16,9,0,38,36,''),
      demo('S09','Grand Forks','Cold','Carhartt','V001','Carhartt','Beanie','OS',50,4,1,0,12,288,''),
      demo('S31','Mankato','Midwest','Wolverine','V002','Wolverine','Hiker','9',8,7,2,0,88,48,''),
    ];
    document.getElementById('pg-kpis').insertAdjacentHTML('beforebegin',
      '<div class="warnbox">Warehouse not reachable — showing a short sample queue so you can walk the approve / delay / handoff / export flow.</div>');
  }
  const H=4, wxOn=true;
  const TEAM=[
    {id:'maya', name:'Maya Chen', role:'Buyer — Carhartt / Wolverine'},
    {id:'tom', name:'Tom Ruiz', role:'Inventory planner'},
    {id:'priya', name:'Priya Shah', role:'Vendor ops / EDI'},
    {id:'jordan', name:'Jordan Hale', role:'Regional merch (Midwest)'},
  ];
  const RULES=[
    {id:'urgent', label:'Cover under 3 weeks, or a 2-week shortfall', bucket:'Approved', why:'Stockout risk inside observed lead time'},
    {id:'healthy', label:'Cover 6+ weeks and no 2-week shortfall', bucket:'Delay', why:'Position already covers the horizon — not needed yet'},
    {id:'moq', label:'Vendor roll-up is below MOQ', bucket:'Review', why:'Cannot ship as-is; buyer or vendor ops should split, pad, or hold'},
    {id:'wx', label:'Weather is more than half of the proposed qty', bucket:'Review', why:'Event-driven demand — confirm the window is still open'},
    {id:'tier', label:'Has a tier-break or preseason note', bucket:'Review', why:'Opportunity buy sitting on a replen PO — merch should weigh in'},
  ];
  function rec(p){
    if(p.wos>=6 && p.need2<=0) return {bucket:'Delay', why:'Cover is healthy — defer this cycle'};
    if(p.belowMoq) return {bucket:'Review', why:'Below vendor MOQ'};
    if(p.wxShare>0.5) return {bucket:'Review', why:'Mostly weather-driven'};
    if(p.tier) return {bucket:'Review', why:'Tier-break / preseason attached'};
    if(p.wos<3 || p.need2>0) return {bucket:'Approved', why:'Cover thin or 2-week need'};
    return {bucket:'Review', why:'Mixed signal — second set of eyes'};
  }
  function matchesRule(p, rid){
    if(rid==='urgent') return p.wos<3 || p.need2>0;
    if(rid==='healthy') return p.wos>=6 && p.need2<=0;
    if(rid==='moq') return p.belowMoq;
    if(rid==='wx') return p.wxShare>0.5;
    if(rid==='tier') return !!p.tier;
    return false;
  }
  // Line math (same as Demand Planning generator), then roll to store × vendor mini-POs.
  const lines=[];
  PO.forEach(r=>{
    const need=+r['fc_'+H+'wk'] + (wxOn? +r['wx_'+H+'wk'] : 0) + +r.safety_stock - +r.position;
    const qty=Math.max(0, Math.ceil(need));
    if(qty<=0) return;
    const need2=Math.max(0, Math.ceil(+r.fc_2wk + (wxOn? +r.wx_2wk : 0) + +r.safety_stock - +r.position));
    lines.push({...r, qty, ext:+(qty*r.unit_cost).toFixed(2), need2, wx:+(wxOn? +r['wx_'+H+'wk'] : 0)});
  });
  const venTot={};
  lines.forEach(l=>{ const k=l.vendor_id; venTot[k]=venTot[k]||{units:0, moq:+l.moq_units}; venTot[k].units+=l.qty; });
  const by={};
  lines.forEach(l=>{
    const k=l.vendor_id+'|'+l.store_id;
    const o=by[k]=by[k]||{id:k, vendor_id:l.vendor_id, vendor:l.vendor_name, store_id:l.store_id, store_name:l.store_name,
      climate:l.climate_zone, lines:0, units:0, cost:0, pos:0, fc4:0, wx:0, need2:0, moq:+l.moq_units, receipt:l.expected_receipt,
      lead:+l.lead_days_p50, notes:new Set(), sku:[]};
    o.lines++; o.units+=l.qty; o.cost+=l.ext; o.pos+=+l.position; o.fc4+=+l.fc_4wk; o.wx+=l.wx; o.need2+=l.need2;
    if(l.tier_break_note) o.notes.add(l.tier_break_note);
    if(o.sku.length<3) o.sku.push(l.brand+' '+l.style_name+' '+l.size);
  });
  const queue=Object.values(by).map(p=>{
    const weekly=p.fc4/4;
    p.wos=weekly>0? +(p.pos/weekly).toFixed(1) : 99;
    p.wxShare=p.units? p.wx/p.units : 0;
    p.belowMoq=venTot[p.vendor_id].units < venTot[p.vendor_id].moq;
    p.tier=[...p.notes][0]||'';
    p.master='MPO-PROP-'+String(p.vendor_id).slice(1);
    p.poId='SPO-'+p.store_id+'-'+p.vendor_id;
    const r=rec(p);
    p.engine=r.bucket; p.engineWhy=r.why;
    p.status=r.bucket; p.why=r.why;
    p.assignee=''; p.note=''; p.sel=false;
    return p;
  }).sort((a,b)=>b.cost-a.cost);

  let tab='Approved';
  let ruleId='urgent';
  let exportOpen=false;
  let exportMethod=null;

  document.getElementById('pg-rule-controls').innerHTML=`
    <div><label>Vendor</label><select id="pg-ven"><option value="">All vendors</option>${uniq(queue.map(p=>p.vendor)).sort().map(c=>`<option>${esc(c)}</option>`).join('')}</select></div>
    <div><label>Region</label><select id="pg-reg"><option value="">All regions</option>${uniq(queue.map(p=>p.climate)).sort().map(c=>`<option>${esc(c)}</option>`).join('')}</select></div>`;
  document.getElementById('pg-rules').innerHTML=RULES.map(r=>`
    <label class="pg-rule"><input type="radio" name="pg-rule" value="${r.id}" ${r.id===ruleId?'checked':''}>
      <span><b>${esc(r.label)}</b> → ${statusChip(r.bucket)}<br><span class="why">${esc(r.why)}</span></span></label>`).join('');
  document.querySelectorAll('input[name="pg-rule"]').forEach(i=>i.onchange=()=>{ ruleId=i.value; });

  document.getElementById('pg-queue-controls').innerHTML=`
    <div><label>Assign to</label><select id="pg-who"><option value="">Choose teammate…</option>${TEAM.map(t=>`<option value="${t.id}">${esc(t.name)} — ${esc(t.role)}</option>`).join('')}</select></div>
    <div style="flex:1;min-width:180px"><label>Question / note</label><input id="pg-q" placeholder="e.g. Pad to MOQ or wait for ATS?" style="border:1px solid #C9D6EC;border-radius:8px;padding:6px 8px;font-size:12.5px;width:100%"></div>`;
  document.getElementById('pg-actions').innerHTML=`
    <button class="btn" id="pg-approve">Approve selected</button>
    <button class="btn ghost" id="pg-delay">Delay selected (next cycle)</button>
    <button class="btn ghost" id="pg-assign">Assign selected</button>
    <button class="btn" id="pg-export" style="margin-left:auto;background:var(--navy)">Export approved…</button>
    <span id="pg-act-msg" style="align-self:center;font-size:12px;color:var(--sub)"></span>`;

  function scoped(){
    const ven=document.getElementById('pg-ven').value, reg=document.getElementById('pg-reg').value;
    return queue.filter(p=>(!ven||p.vendor===ven)&&(!reg||p.climate===reg));
  }
  function visible(){
    const s=scoped();
    if(tab==='All') return s;
    if(tab==='Assigned') return s.filter(p=>p.status==='Assigned');
    return s.filter(p=>p.status===tab);
  }
  function kpis(){
    const s=scoped();
    const n=st=>s.filter(p=>p.status===st).length;
    const $ =st=>s.filter(p=>p.status===st).reduce((a,p)=>a+p.cost,0);
    document.getElementById('pg-kpis').innerHTML=[
      ['Proposed store POs', fmtN(s.length), uniq(s.map(p=>p.vendor_id)).length+' master POs'],
      ['Ready to approve', fmtN(n('Approved')), fmt$($('Approved')), n('Approved')?'good':''],
      ['Delay / not yet', fmtN(n('Delay')), fmt$($('Delay')), ''],
      ['Need a teammate', fmtN(n('Review')+n('Assigned')), n('Assigned')+' already assigned', (n('Review')+n('Assigned'))?'warn':''],
      ['Exported', fmtN(n('Exported')), fmt$($('Exported')), n('Exported')?'good':''],
    ].map(x=>`<div class="kpi ${x[3]||''}"><div class="lbl">${x[0]}</div><div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  }
  function tabs(){
    const s=scoped();
    const counts={Approved:0,Delay:0,Review:0,Assigned:0,Exported:0,All:s.length};
    s.forEach(p=>{ counts[p.status]=(counts[p.status]||0)+1; });
    const labels=[['Approved','Approve'],['Delay','Delay'],['Review','Review'],['Assigned','Assigned'],['Exported','Exported'],['All','All']];
    document.getElementById('pg-tabs').innerHTML=labels.map(([id,lab])=>
      `<button data-t="${id}" class="${tab===id?'active':''}">${lab} <b>${counts[id]||0}</b></button>`).join('');
    document.querySelectorAll('#pg-tabs button').forEach(b=>b.onclick=()=>{ tab=b.dataset.t; render(); });
  }
  function render(){
    kpis(); tabs();
    const rows=visible();
    if(!rows.length){ document.getElementById('pg-tbl').innerHTML='<div class="loading">Nothing in this pile.</div>'; return; }
    const head=`<th><input type="checkbox" id="pg-all"></th><th>Proposed PO</th><th>Vendor / store</th><th>Lines</th><th>Units</th><th>Est. cost</th><th>Cover (wks)</th><th>Why this pile</th><th>Owner</th><th>Status</th>`;
    const body=rows.map(p=>`<tr data-id="${esc(p.id)}">
      <td><input type="checkbox" class="pg-ck" ${p.sel?'checked':''}></td>
      <td><span class="mono" style="font-size:11px">${esc(p.poId)}</span><br><span style="color:var(--sub)">${esc(p.master)}</span></td>
      <td><b>${esc(p.vendor.split(' ')[0])}</b><br>${esc(p.store_id)} · ${esc(p.store_name)}</td>
      <td class="num">${p.lines}</td>
      <td class="num">${fmtN(p.units)}</td>
      <td class="num">${fmt$(p.cost)}</td>
      <td class="num">${p.wos>=99?'—':p.wos}</td>
      <td style="font-size:11.5px;color:var(--sub);max-width:240px">${esc(p.why)}${p.note?' — '+esc(p.note):''}<br><span style="color:#93a1bb">${esc(p.sku.slice(0,2).join(' · '))}</span></td>
      <td style="font-size:12px">${p.assignee?esc(TEAM.find(t=>t.id===p.assignee)?.name||p.assignee):'—'}</td>
      <td>${statusChip(p.status)}</td>
    </tr>`).join('');
    document.getElementById('pg-tbl').innerHTML=`<div class="tblwrap" style="max-height:520px"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend"><span>Showing ${fmtN(rows.length)} of ${fmtN(scoped().length)} in scope · 4-week horizon, weather included (same math as Demand Planning).</span></div>`;
    document.getElementById('pg-all').onchange=e=>{
      const on=e.target.checked; rows.forEach(p=>p.sel=on); render();
    };
    document.querySelectorAll('#pg-tbl .pg-ck').forEach(ck=>{
      ck.onchange=()=>{ const id=ck.closest('tr').dataset.id; const p=queue.find(x=>x.id===id); if(p) p.sel=ck.checked; };
    });
    if(exportOpen) drawExport();
  }
  function selected(){ return visible().filter(p=>p.sel); }
  function act(fn, msg){
    const rows=selected();
    if(!rows.length){ document.getElementById('pg-act-msg').textContent='Select at least one PO.'; return; }
    rows.forEach(fn); rows.forEach(p=>p.sel=false);
    document.getElementById('pg-act-msg').textContent=msg(rows.length);
    render();
  }
  document.getElementById('pg-apply').onclick=()=>{
    const hits=scoped().filter(p=>p.status!=='Exported' && matchesRule(p, ruleId));
    const r=RULES.find(x=>x.id===ruleId);
    hits.forEach(p=>{ p.status=r.bucket; p.why=r.why; if(r.bucket!=='Assigned') p.assignee=''; });
    document.getElementById('pg-rule-msg').textContent=`Moved ${fmtN(hits.length)} matching POs → ${r.bucket}.`;
    tab=r.bucket; render();
  };
  document.getElementById('pg-reset').onclick=()=>{
    scoped().filter(p=>p.status!=='Exported').forEach(p=>{ p.status=p.engine; p.why=p.engineWhy; p.assignee=''; p.note=''; p.sel=false; });
    document.getElementById('pg-rule-msg').textContent='Restored engine recommendations.';
    tab='Approved'; render();
  };
  document.getElementById('pg-approve').onclick=()=>act(p=>{ p.status='Approved'; p.why='Buyer approved'; }, n=>`Approved ${n}.`);
  document.getElementById('pg-delay').onclick=()=>act(p=>{ p.status='Delay'; p.why='Held for next cycle'; p.assignee=''; }, n=>`Delayed ${n}.`);
  document.getElementById('pg-assign').onclick=()=>{
    const who=document.getElementById('pg-who').value, q=document.getElementById('pg-q').value.trim();
    if(!who){ document.getElementById('pg-act-msg').textContent='Pick a teammate first.'; return; }
    act(p=>{ p.status='Assigned'; p.assignee=who; p.note=q; p.why='Handed off — '+q; }, n=>`Assigned ${n} to ${TEAM.find(t=>t.id===who).name}.`);
    tab='Assigned'; render();
  };
  document.getElementById('pg-ven').onchange=render;
  document.getElementById('pg-reg').onchange=render;

  const EXPORTS=[
    {id:'csv', title:'NetSuite CSV import', tag:'Download → upload',
      blurb:'Standard Purchase Order CSV (custom record or Transactions > Import CSV). Buyer downloads, merch ops drops it on the NetSuite CSV import saved map for Vendor Bill / Purchase Order. Fastest path for a demo and for vendors without EDI.',
      file:'WW_NetSuite_PO_import.csv', kind:'csv'},
    {id:'edi', title:'EDI X12 850 (SPS Commerce)', tag:'Standard report form',
      blurb:'Purchase Order 850 through the existing SPS pipe used for Carhartt / Wolverine 846. One interchange per master PO; store mini-POs as N1/PO1 loops. NetSuite consumes the 855 ack on the way back.',
      file:'WW_PO_850.edi.txt', kind:'edi'},
    {id:'api', title:'NetSuite REST / SuiteTalk', tag:'System-to-system',
      blurb:'POST purchaseOrder (REST) or upsert via SOAP. Token-based auth from this app\'s service principal. Best when POs should land without a file landing zone — still human-approved in this queue first.',
      file:'WW_NetSuite_PO_payload.json', kind:'json'},
    {id:'cabinet', title:'File Cabinet + Map/Reduce', tag:'NetSuite-native job',
      blurb:'Drop a delimited file in the NetSuite File Cabinet; a scheduled Map/Reduce (or SuiteFlow) picks it up, creates POs, and writes a results file back. Fits IT-owned integration calendars.',
      file:'WW_FileCabinet_PO.txt', kind:'csv'},
    {id:'xlsx', title:'Excel buyer packet', tag:'Review then import',
      blurb:'Workbook merchandising already lives in: one sheet per vendor master PO, store tabs, MOQ flags. After sign-off, Save As CSV and use the same NetSuite import map as option 1.',
      file:'WW_buyer_packet.csv', kind:'csv'},
    {id:'portal', title:'Vendor portal / 3PL pack', tag:'When they will not take 850',
      blurb:'Some brands only take a portal spreadsheet or a 3PL ASN-ready pack. Same store×SKU qty, different envelope. NetSuite still gets a PO via CSV or API so 3-way match has a header to land on.',
      file:'WW_vendor_portal_pack.csv', kind:'csv'},
  ];

  function approvedRows(){ return scoped().filter(p=>p.status==='Approved'); }
  function csvFor(rows){
    const cols=['externalid','vendor','store_id','store_name','master_po','qty','amount','expected_receipt','lead_days','memo'];
    const body=rows.map(p=>[p.poId,`"${p.vendor}"`,p.store_id,`"${p.store_name}"`,p.master,p.units,p.cost.toFixed(2),String(p.receipt).slice(0,10),p.lead,`"${(p.why||'').replace(/"/g,'')} ${p.tier||''}"`].join(','));
    return [cols.join(',')].concat(body).join('\n');
  }
  function ediFor(rows){
    const byVen={};
    rows.forEach(p=>{ (byVen[p.vendor]=byVen[p.vendor]||[]).push(p); });
    const parts=['ISA*00*          *00*          *ZZ*WORKWORLD     *ZZ*NETSUITE      *260714*1200*U*00401*000000001*0*P*>~',
      'GS*PO*WORKWORLD*NETSUITE*20260714*1200*1*X*004010~'];
    let i=1;
    Object.entries(byVen).forEach(([ven,ps])=>{
      parts.push(`ST*850*${String(i).padStart(4,'0')}~`);
      parts.push(`BEG*00*SA*${ps[0].master}*20260714~`);
      parts.push(`N1*VN*${ven}~`);
      ps.forEach(p=>parts.push(`PO1**${p.units}*EA***VN*${p.poId}*ST*${p.store_id}~`));
      parts.push(`CTT*${ps.length}~`);
      parts.push(`SE*${6+ps.length}*${String(i).padStart(4,'0')}~`);
      i++;
    });
    parts.push('GE*1*1~','IEA*1*000000001~');
    return parts.join('\n');
  }
  function jsonFor(rows){
    return JSON.stringify({source:'ww-merch-ops',anchor:ANCHOR,recordType:'purchaseOrder',
      orders:rows.map(p=>({externalId:p.poId, vendor:p.vendor, location:p.store_id, memo:p.master,
        expectedReceipt:String(p.receipt).slice(0,10), quantity:p.units, amount:+p.cost.toFixed(2)}))}, null, 2);
  }
  function payload(m, rows){
    if(m.kind==='edi') return ediFor(rows);
    if(m.kind==='json') return jsonFor(rows);
    return csvFor(rows);
  }
  function drawExport(){
    const card=document.getElementById('pg-export-card');
    card.style.display='';
    const n=approvedRows().length;
    document.getElementById('pg-export-grid').innerHTML=EXPORTS.map(m=>`
      <button class="export-card ${exportMethod===m.id?'on':''}" data-x="${m.id}">
        <div class="xtag">${esc(m.tag)}</div>
        <h4>${esc(m.title)}</h4>
        <p>${esc(m.blurb)}</p>
      </button>`).join('') +
      `<div class="export-card muted"><div class="xtag">Same payload</div><h4>${fmtN(n)} approved store POs</h4>
        <p>Pick a path. The file is generated from the Approve pile only — delayed and assigned rows stay in this app until someone acts.</p></div>`;
    document.querySelectorAll('#pg-export-grid .export-card[data-x]').forEach(b=>b.onclick=()=>{
      exportMethod=b.dataset.x; previewExport();
      document.querySelectorAll('#pg-export-grid .export-card').forEach(x=>x.classList.toggle('on', x.dataset.x===exportMethod));
    });
    if(exportMethod) previewExport();
    else document.getElementById('pg-export-preview').innerHTML='<div class="hint" style="margin-top:12px">Select a path to preview the file NetSuite (or SPS) would ingest.</div>';
  }
  function previewExport(){
    const m=EXPORTS.find(x=>x.id===exportMethod);
    const rows=approvedRows();
    const body=payload(m, rows);
    const mime=m.kind==='json'?'application/json': m.kind==='edi'?'text/plain':'text/csv';
    document.getElementById('pg-export-preview').innerHTML=`
      <div class="export-preview">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
          <b>${esc(m.title)}</b>
          <span class="chip blue">${fmtN(rows.length)} POs</span>
          <button class="btn" id="pg-dl">Download ${esc(m.file)}</button>
          <button class="btn ghost" id="pg-mark">Mark pile as exported</button>
          <span id="pg-xmsg" style="font-size:12px;color:var(--sub)"></span>
        </div>
        <pre class="sqlbox" style="display:block;max-height:220px;overflow:auto">${esc(body.slice(0,3500))}${body.length>3500?'\n…':''}</pre>
      </div>`;
    document.getElementById('pg-dl').onclick=()=>{
      try{
        const blob=new Blob([body],{type:mime}); const a=document.createElement('a');
        a.href=URL.createObjectURL(blob); a.download=m.file; a.click();
        document.getElementById('pg-xmsg').textContent='Downloaded — drop this on the NetSuite / SPS side (demo file).';
      }catch(e){ document.getElementById('pg-xmsg').textContent='Download blocked in this view.'; }
    };
    document.getElementById('pg-mark').onclick=()=>{
      rows.forEach(p=>{ p.status='Exported'; p.why='Sent via '+m.title; p.sel=false; });
      document.getElementById('pg-xmsg').textContent='Approved pile marked exported. Delayed / assigned rows remain.';
      tab='Exported'; render();
    };
  }
  document.getElementById('pg-export').onclick=()=>{
    if(!approvedRows().length){ document.getElementById('pg-act-msg').textContent='Nothing in Approve yet.'; return; }
    exportOpen=true; drawExport();
    document.getElementById('pg-export-card').scrollIntoView({behavior:'smooth', block:'start'});
  };
  render();
},

async ats(){
  const rows=await runQ(`SELECT * FROM ${S}.ats_coverage_v ORDER BY items_reported DESC`);
  document.getElementById('ats-tbl').innerHTML='<h3>Coverage by vendor — latest snapshot</h3><div class="hint">Crossref match rate is the health metric: unmatched vendor SKUs can\'t inform ordering.</div>'+table(rows,[
    {h:'Vendor',f:r=>`<b>${esc(r.vendor_name)}</b>`},{h:'Tier',k:'sophistication'},
    {h:'Method',f:r=>`<span class="chip ${r.capture_method==='EDI 846'?'green':r.capture_method==='Portal download'?'blue':'orange'}">${esc(r.capture_method)}</span>`},
    {h:'Items',k:'items_reported',num:1},{h:'Matched',k:'items_matched',num:1},
    {h:'Match rate',f:r=>r.match_rate_pct+'%',num:1},{h:'Zero ATS',k:'zero_ats_items',num:1},
    {h:'Next avail',f:r=>r.earliest_next_avail?String(r.earliest_next_avail).slice(0,10):'—'}]);
},
async deals(){
  const rows=await runQ(`SELECT * FROM ${S}.deal_pipeline_v ORDER BY CASE status WHEN 'Open' THEN 0 ELSE 1 END, days_to_expiry`);
  const open=rows.filter(r=>r.status==='Open');
  document.getElementById('deal-kpis').innerHTML=[
    ['Open offers',open.length,'awaiting decision'],
    ['Savings at commit',fmt$(open.reduce((a,r)=>a+ +r.savings_at_commit,0)),'if all open offers accepted'],
    ['Expiring soon',open.filter(r=>+r.days_to_expiry<=7).length,'within 7 days'],
  ].map(k=>`<div class="kpi"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
  document.getElementById('deal-tbl').innerHTML='<h3>Deal pipeline</h3><div class="hint">AI recommendation weighs margin uplift against weeks-of-supply and broken-run risk.</div>'+table(rows,[
    {h:'ID',f:r=>`<span class="mono" style="font-size:11px">${esc(r.opp_id)}</span>`},
    {h:'Vendor',f:r=>`<b>${esc(r.vendor_name)}</b><br><span style="color:var(--sub)">${esc(r.opp_type)}</span>`},
    {h:'Offer',f:r=>esc(r.description)},
    {h:'Commit',k:'commit_qty',num:1},
    {h:'Savings',f:r=>fmt$(r.savings_at_commit),num:1},
    {h:'Uplift',f:r=>r.margin_uplift_pct+'%',num:1},
    {h:'WOS',k:'est_weeks_of_supply',num:1},
    {h:'Expires',f:r=>r.days_to_expiry>0?('in '+r.days_to_expiry+'d'):'—'},
    {h:'AI call',f:r=>`<span style="font-size:11.5px">${esc(r.ai_recommendation)}</span>`},
    {h:'Status',f:r=>statusChip(r.status)}]);
},
async match(){
  const sum=await runQ(`SELECT variance_type, sum(variance_amount) amt, count(*) n FROM ${S}.exception_queue_v GROUP BY 1 ORDER BY amt DESC`);
  const [k]=await runQ(`SELECT auto_clear_pct, open_exceptions, open_exception_amt FROM ${S}.kpi_summary_v`);
  const life=await runQ(`SELECT status, past_requested_ship, count(*) n, round(sum(open_value),0) ov FROM ${S}.po_lifecycle_v GROUP BY 1,2`);
  const openPos=life.filter(r=>r.status==='Open').reduce((a,r)=>a+ +r.n,0);
  const openVal=life.filter(r=>r.status==='Open').reduce((a,r)=>a+ +r.ov,0);
  const lateOpen=life.filter(r=>r.status==='Open'&&r.past_requested_ship==='true').reduce((a,r)=>a+ +r.n,0);
  const stmts=await runQ(`SELECT * FROM ${S}.statement_recon_v ORDER BY open_exception_amt DESC, statement_total DESC`);
  const holds=stmts.filter(r=>r.recon_status!=='Clear to pay');
  const trend=await runQ(`SELECT * FROM ${S}.match_trend_v ORDER BY match_month`);
  const recovered=trend.reduce((a,r)=>a+ +r.variance_recovered,0);
  document.getElementById('m-kpis').innerHTML=[
    ['Auto-clear rate',k.auto_clear_pct+'%','of matched lines need no human',''],
    ['Open exceptions',k.open_exceptions,fmt$(k.open_exception_amt)+' awaiting recovery','warn'],
    ['Variance recovered',fmt$(recovered),'trailing 12 months','good'],
    ['Open POs',openPos,fmt$(openVal)+' on order · '+lateOpen+' past requested ship',lateOpen?'warn':''],
    ['Statements on hold',holds.length,'of '+stmts.length+' — exceptions block payment',holds.length?'warn':'good'],
  ].map(x=>`<div class="kpi ${x[3]}"><div class="lbl">${x[0]}</div><div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  // ---- document explorer ----
  const tree=await runQ(`SELECT * FROM ${S}.po_document_tree_v`);
  const masters={};
  tree.forEach(r=>{ const m=masters[r.master_po_id]=masters[r.master_po_id]||{id:r.master_po_id,vendor:r.vendor_name,date:r.master_order_date,type:r.po_type,rows:[],exc:0,excAmt:0,val:0};
    m.rows.push(r); m.exc+=+r.open_exceptions; m.excAmt+=+r.open_exception_amt; m.val+=+r.po_value; });
  const mlist=Object.values(masters).sort((a,b)=> b.exc-a.exc || String(b.date).localeCompare(String(a.date))).slice(0,30);
  document.getElementById('doc-controls').innerHTML=`<div><label>Master PO</label><select id="doc-sel">${mlist.map((m,i)=>`<option value="${m.id}" ${i===0?'selected':''}>${m.id} — ${m.vendor.split(' ')[0]} · ${String(m.date).slice(0,10)} · ${m.type}${m.exc?' · '+m.exc+' exceptions':''}</option>`).join('')}</select></div>`;
  function renderTree(){
    const m=masters[document.getElementById('doc-sel').value];
    const recvd=m.rows.reduce((a,r)=>a+ +r.qty_received,0), ord=m.rows.reduce((a,r)=>a+ +r.qty_ordered,0);
    document.getElementById('doc-summary').innerHTML=`<div class="legend" style="margin-bottom:10px">
      <span class="mono" style="color:var(--navy);font-weight:700">${m.id}</span>
      <span><b>${esc(m.vendor)}</b> · ${m.type} · ordered ${String(m.date).slice(0,10)}</span>
      <span>${m.rows.length} store POs · ${fmtN(ord)} units ordered · ${fmtN(recvd)} received · ${fmt$(m.val)} value</span>
      <span>${m.exc?`<span class="chip red">${m.exc} open exceptions · ${fmt$(m.excAmt)}</span>`:'<span class="chip green">Fully reconciled</span>'}</span></div>`;
    const rows=[...m.rows].sort((a,b)=>String(a.store_id).localeCompare(String(b.store_id)));
    document.getElementById('doc-tree').innerHTML=table(rows,[
      {h:'Mini-PO / Store',f:r=>`<span class="mono" style="font-size:11px">${esc(r.po_id)}</span><br><b>${esc(r.store_id)}</b> <span style="color:var(--sub)">${esc(r.store_name||'')}</span>`},
      {h:'855 ack',f:r=>`<span class="chip ${r.edi_855_ack==='Accepted'?'green':r.edi_855_ack==='AcceptedWithChanges'?'orange':'gray'}">${esc(r.edi_855_ack)}</span>`},
      {h:'PO',f:r=>statusChip(r.po_status)},
      {h:'Ord / Recv / Cxl',f:r=>`${r.qty_ordered} / ${r.qty_received} / ${r.qty_cancelled}`,num:1},
      {h:'Value',f:r=>fmt$(r.po_value),num:1},
      {h:'Receiver',f:r=>r.receiver_id?`<span class="mono" style="font-size:10.5px">${esc(r.receiver_id)}</span><br>${statusChip(r.receiver_status)} <span style="color:var(--sub)">${String(r.received_date).slice(0,10)}</span>`:'<span style="color:var(--sub)">—</span>'},
      {h:'Invoice',f:r=>r.invoice_id?`<span class="mono" style="font-size:10.5px">${esc(r.invoice_id)}</span><br>${fmt$(r.invoice_total)} ${r.invoice_status?statusChip(r.invoice_status==='Exception'?'PendingReview':r.invoice_status==='Matched'?'AutoCleared':'Resolved'):''}`:'<span style="color:var(--sub)">—</span>'},
      {h:'Statement',f:r=>r.master_statement_id?`<span class="mono" style="font-size:10.5px">${esc(r.master_statement_id)}</span>`:'—'},
      {h:'Match',f:r=>+r.open_exceptions?`<span class="chip red">${r.open_exceptions} open · ${fmt$(r.open_exception_amt)}</span>`:(+r.total_exceptions?'<span class="chip green">Resolved</span>':(r.invoice_id?'<span class="chip green">Clean</span>':'<span style="color:var(--sub)">pending docs</span>'))}]);
  }
  document.getElementById('doc-sel').onchange=renderTree;
  renderTree();
  // ---- trend ----
  mkChart('ch-mtrend','bar',{labels:trend.map(r=>String(r.match_month).slice(0,7)),datasets:[
    {label:'Identified $',data:trend.map(r=>+r.variance_identified),backgroundColor:'#9fb0cc'},
    {label:'Recovered $',data:trend.map(r=>+r.variance_recovered),backgroundColor:'#1E9E5A'},
    {label:'Still open $',data:trend.map(r=>+r.variance_open),backgroundColor:'#C0392B'},
    {label:'Auto-clear %',type:'line',yAxisID:'y1',data:trend.map(r=>+r.auto_clear_pct),borderColor:'#2E5BFF',borderWidth:2,pointRadius:2,tension:.3}]},
    {scales:{y:{ticks:{callback:x=>'$'+fmtN(x)}},y1:{position:'right',min:80,max:100,grid:{drawOnChartArea:false},ticks:{callback:x=>x+'%'}}}});
  // ---- aging ----
  const exAll=await runQ(`SELECT age_days, variance_amount FROM ${S}.exception_queue_v`);
  const buckets={'0-15d':0,'16-30d':0,'31-60d':0,'60d+':0};
  exAll.forEach(r=>{const a=+r.age_days; const b=a<=15?'0-15d':a<=30?'16-30d':a<=60?'31-60d':'60d+'; buckets[b]++;});
  mkChart('ch-mage','bar',{labels:Object.keys(buckets),datasets:[{label:'Open exceptions',data:Object.values(buckets),
    backgroundColor:['#1E9E5A','#2E5BFF','#C55A11','#C0392B']}]},{plugins:{legend:{display:false}}});
  mkChart('ch-var','doughnut',{labels:sum.map(r=>r.variance_type),datasets:[{data:sum.map(r=>+r.amt),
    backgroundColor:['#C0392B','#C55A11','#7C4DBE','#2E5BFF','#1B9E9E']}]},{plugins:{legend:{position:'right',labels:{font:{size:10}}}}});
  // ---- statements ----
  document.getElementById('m-stmt').innerHTML=table(stmts.slice(0,20),[
    {h:'Statement',f:r=>`<span class="mono" style="font-size:11px">${esc(r.master_statement_id)}</span><br><b>${esc(r.vendor_name.split(' ')[0])}</b>`},
    {h:'Inv',k:'invoice_count',num:1},
    {h:'Total',f:r=>fmt$(r.statement_total),num:1},
    {h:'Open exc',f:r=>+r.open_exceptions?`${r.open_exceptions} · ${fmt$(r.open_exception_amt)}`:'—',num:1},
    {h:'Due',f:r=>`${String(r.last_due).slice(0,10)}`},
    {h:'Status',f:r=>`<span class="chip ${r.recon_status==='Clear to pay'?'green':r.recon_status==='Pay less debit memos'?'blue':'red'}">${esc(r.recon_status)}</span>`}]);
  const rows=await runQ(`SELECT * FROM ${S}.exception_queue_v`);
  const byType={};
  rows.forEach(r=>{ const k=r.variance_type||'Other'; byType[k]=byType[k]||{type:k,n:0,amt:0,old:0}; byType[k].n++; byType[k].amt+=+r.variance_amount; if(+r.age_days>=30) byType[k].old++; });
  const types=Object.values(byType).sort((a,b)=>b.amt-a.amt);
  document.getElementById('m-tbl').innerHTML=table(types,[
    {h:'Cause',f:r=>statusChip(r.type)},
    {h:'Open lines',f:r=>fmtN(r.n),num:1},
    {h:'Open $',f:r=>fmt$(r.amt),num:1},
    {h:'Aged 30d+',f:r=>r.old?`<span style="color:var(--red);font-weight:700">${r.old}</span>`:'—',num:1}])
    + `<div style="margin-top:12px"><button class="btn" onclick="show('matchq')">Open Exception triage →</button>
      <span style="margin-left:10px;font-size:12px;color:var(--sub)">${fmtN(rows.length)} lines still need a clear / debit / hold decision in NetSuite.</span></div>`;
},

async matchq(){
  let rows=[];
  try{ rows=await runQ(`SELECT * FROM ${S}.exception_queue_v ORDER BY variance_amount DESC`); }
  catch(e){
    rows=[
      {match_id:'M-1001',po_id:'PO-S01-V001-07',invoice_id:'INV-4412',vendor_name:'Carhartt',store_id:'S01',brand:'Carhartt',style_name:'Dungaree Jacket',size:'L',variance_type:'PriceVariance',variance_amount:'18.40',age_days:'6',ai_suggested_resolution:'Accept — under $25 tolerance',status:'PendingReview'},
      {match_id:'M-1002',po_id:'PO-S04-V002-07',invoice_id:'INV-4480',vendor_name:'Wolverine',store_id:'S04',brand:'Wolverine',style_name:'Steel Toe',size:'10',variance_type:'QtyShort',variance_amount:'192.00',age_days:'11',ai_suggested_resolution:'Issue debit memo for 2 units short-shipped',status:'PendingReview'},
      {match_id:'M-1003',po_id:'PO-S12-V001-07',invoice_id:'INV-4419',vendor_name:'Carhartt',store_id:'S12',brand:'Carhartt',style_name:'Work Pant',size:'32x32',variance_type:'Freight',variance_amount:'64.50',age_days:'22',ai_suggested_resolution:'Confirm FOB terms before debiting freight',status:'PendingReview'},
      {match_id:'M-1004',po_id:'PO-S08-V012-06',invoice_id:'INV-3901',vendor_name:'Helly Hansen',store_id:'S08',brand:'Helly Hansen',style_name:'Rain Jacket',size:'XL',variance_type:'PriceVariance',variance_amount:'740.00',age_days:'38',ai_suggested_resolution:'Material price variance — buyer + AP jointly',status:'PendingReview'},
      {match_id:'M-1005',po_id:'PO-S18-V006-07',invoice_id:'INV-4502',vendor_name:'Dickies',store_id:'S18',brand:'Dickies',style_name:'Coverall',size:'L',variance_type:'QtyShort',variance_amount:'114.00',age_days:'9',ai_suggested_resolution:'Debit 3 units; receiver shows short',status:'DebitMemoSent'},
      {match_id:'M-1006',po_id:'PO-S22-V008-07',invoice_id:'INV-4555',vendor_name:'Red Kap',store_id:'S22',brand:'Red Kap',style_name:'Work Shirt',size:'L',variance_type:'Freight',variance_amount:'12.00',age_days:'4',ai_suggested_resolution:'Write off freight under tolerance',status:'PendingReview'},
      {match_id:'M-1007',po_id:'PO-S09-V001-06',invoice_id:'INV-4010',vendor_name:'Carhartt',store_id:'S09',brand:'Carhartt',style_name:'Beanie',size:'OS',variance_type:'CostVariance',variance_amount:'310.00',age_days:'41',ai_suggested_resolution:'Hold statement — receiver not posted',status:'PendingReview'},
      {match_id:'M-1008',po_id:'PO-S31-V002-07',invoice_id:'INV-4601',vendor_name:'Wolverine',store_id:'S31',brand:'Wolverine',style_name:'Hiker',size:'9',variance_type:'PriceVariance',variance_amount:'22.80',age_days:'3',ai_suggested_resolution:'Accept — catalog vs PO rounding',status:'PendingReview'},
    ];
    document.getElementById('mx-kpis').insertAdjacentHTML('beforebegin',
      '<div class="warnbox">Warehouse not reachable — showing a sample exception queue so you can walk clear / debit / hold / assign / NetSuite post.</div>');
  }
  const TEAM=[
    {id:'ap', name:'Chris Nguyen', role:'AP specialist'},
    {id:'buyer', name:'Maya Chen', role:'Buyer — Carhartt / Wolverine'},
    {id:'stores', name:'Jordan Hale', role:'Regional merch (receivers)'},
    {id:'vendor', name:'Priya Shah', role:'Vendor ops / EDI'},
  ];
  const RULES=[
    {id:'tol', label:'Absolute variance under $25', bucket:'Clear', why:'Policy tolerance — write off / accept the bill'},
    {id:'short', label:'Qty short (or AI already says debit)', bucket:'Debit', why:'Recoverable — vendor credit / debit memo'},
    {id:'aged', label:'Aged 30+ days and over $500', bucket:'Review', why:'Material and stale — AP + buyer together'},
    {id:'freight', label:'Freight over tolerance', bucket:'Review', why:'Often contractual — confirm FOB before debiting'},
    {id:'inflight', label:'Debit memo already sent', bucket:'Debit', why:'Confirm the credit landed in NetSuite AP'},
  ];
  function rec(r){
    const amt=Math.abs(+r.variance_amount), age=+r.age_days, t=String(r.variance_type||''), ai=String(r.ai_suggested_resolution||'').toLowerCase();
    if(r.status==='DebitMemoSent') return {bucket:'Debit', why:'Debit memo already issued'};
    if(amt<25) return {bucket:'Clear', why:'Under $25 tolerance'};
    if(/qty|short/i.test(t) || /debit|short-ship|short ship/i.test(ai)) return {bucket:'Debit', why:'Qty/cost recovery'};
    if(age>=30 && amt>500) return {bucket:'Review', why:'Aged and material'};
    if(/freight/i.test(t)) return {bucket:'Review', why:'Confirm freight terms'};
    if(/hold|receiver/i.test(ai)) return {bucket:'Hold', why:'Docs still catching up'};
    return {bucket:'Review', why:'Needs a human call'};
  }
  function matchesRule(r, id){
    const amt=Math.abs(+r.variance_amount), age=+r.age_days, t=String(r.variance_type||''), ai=String(r.ai_suggested_resolution||'').toLowerCase();
    if(id==='tol') return amt<25;
    if(id==='short') return /qty|short/i.test(t) || /debit|short/i.test(ai);
    if(id==='aged') return age>=30 && amt>500;
    if(id==='freight') return /freight/i.test(t) && amt>=25;
    if(id==='inflight') return r.status==='DebitMemoSent';
    return false;
  }
  const queue=rows.map((r,i)=>{
    const recd=rec(r);
    return {...r, id:r.match_id||('EX-'+i), amt:+r.variance_amount, engine:recd.bucket, engineWhy:recd.why,
      pile:recd.bucket, why:recd.why, assignee:'', note:'', sel:false};
  });
  let tab='Clear', ruleId='tol', exportOpen=false, exportMethod=null;

  document.getElementById('mx-rule-controls').innerHTML=`
    <div><label>Vendor</label><select id="mx-ven"><option value="">All vendors</option>${uniq(queue.map(p=>p.vendor_name)).sort().map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div><label>Cause</label><select id="mx-cause"><option value="">All causes</option>${uniq(queue.map(p=>p.variance_type)).sort().map(c=>`<option>${c}</option>`).join('')}</select></div>`;
  document.getElementById('mx-rules').innerHTML=RULES.map(r=>`
    <label class="pg-rule"><input type="radio" name="mx-rule" value="${r.id}" ${r.id===ruleId?'checked':''}>
      <span><b>${esc(r.label)}</b> → ${statusChip(r.bucket)}<br><span class="why">${esc(r.why)}</span></span></label>`).join('');
  document.querySelectorAll('input[name="mx-rule"]').forEach(i=>i.onchange=()=>{ ruleId=i.value; });
  document.getElementById('mx-queue-controls').innerHTML=`
    <div><label>Assign to</label><select id="mx-who"><option value="">Choose teammate…</option>${TEAM.map(t=>`<option value="${t.id}">${esc(t.name)} — ${esc(t.role)}</option>`).join('')}</select></div>
    <div style="flex:1;min-width:180px"><label>Question / note</label><input id="mx-q" placeholder="e.g. Receiver posted in store but not in NS?" style="border:1px solid #C9D6EC;border-radius:8px;padding:6px 8px;font-size:12.5px;width:100%"></div>`;
  document.getElementById('mx-actions').innerHTML=`
    <button class="btn" id="mx-clear">Clear selected (write off / accept)</button>
    <button class="btn ghost" id="mx-debit">Debit selected</button>
    <button class="btn ghost" id="mx-hold">Hold pay-file</button>
    <button class="btn ghost" id="mx-assign">Assign selected</button>
    <button class="btn" id="mx-export" style="margin-left:auto;background:var(--navy)">Post to NetSuite…</button>
    <span id="mx-act-msg" style="align-self:center;font-size:12px;color:var(--sub)"></span>`;

  function scoped(){
    const ven=document.getElementById('mx-ven').value, cause=document.getElementById('mx-cause').value;
    return queue.filter(p=>(!ven||p.vendor_name===ven)&&(!cause||p.variance_type===cause));
  }
  function visible(){
    const s=scoped();
    if(tab==='All') return s;
    if(tab==='Assigned') return s.filter(p=>p.pile==='Assigned');
    return s.filter(p=>p.pile===tab);
  }
  function kpis(){
    const s=scoped();
    const n=st=>s.filter(p=>p.pile===st).length;
    const $=st=>s.filter(p=>p.pile===st).reduce((a,p)=>a+p.amt,0);
    document.getElementById('mx-kpis').innerHTML=[
      ['Open exceptions', fmtN(s.filter(p=>p.pile!=='Posted').length), fmt$(s.filter(p=>p.pile!=='Posted').reduce((a,p)=>a+p.amt,0))+' in play'],
      ['Clear / accept', fmtN(n('Clear')), fmt$($('Clear')), n('Clear')?'good':''],
      ['Debit / recover', fmtN(n('Debit')), fmt$($('Debit')), n('Debit')?'good':''],
      ['Hold pay-file', fmtN(n('Hold')), fmt$($('Hold')), n('Hold')?'warn':''],
      ['Need a teammate', fmtN(n('Review')+n('Assigned')), n('Assigned')+' already assigned', (n('Review')+n('Assigned'))?'warn':''],
      ['Posted to NS', fmtN(n('Posted')), fmt$($('Posted')), n('Posted')?'good':''],
    ].map(x=>`<div class="kpi ${x[3]||''}"><div class="lbl">${x[0]}</div><div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  }
  function tabs(){
    const s=scoped();
    const counts={Clear:0,Debit:0,Hold:0,Review:0,Assigned:0,Posted:0,All:s.length};
    s.forEach(p=>{ counts[p.pile]=(counts[p.pile]||0)+1; });
    const labels=[['Clear','Clear'],['Debit','Debit'],['Hold','Hold'],['Review','Review'],['Assigned','Assigned'],['Posted','Posted'],['All','All']];
    document.getElementById('mx-tabs').innerHTML=labels.map(([id,lab])=>
      `<button data-t="${id}" class="${tab===id?'active':''}">${lab} <b>${counts[id]||0}</b></button>`).join('');
    document.querySelectorAll('#mx-tabs button').forEach(b=>b.onclick=()=>{ tab=b.dataset.t; render(); });
  }
  function render(){
    kpis(); tabs();
    const vis=visible();
    if(!vis.length){ document.getElementById('mx-tbl').innerHTML='<div class="loading">Nothing in this pile.</div>'; return; }
    const head=`<th><input type="checkbox" id="mx-all"></th><th>PO / Invoice</th><th>Vendor / store</th><th>Item</th><th>Cause</th><th>$</th><th>Age</th><th>Why this pile</th><th>Owner</th><th>Status</th>`;
    const body=vis.map(p=>`<tr data-id="${esc(p.id)}">
      <td><input type="checkbox" class="mx-ck" ${p.sel?'checked':''}></td>
      <td><span class="mono" style="font-size:11px">${esc(p.po_id)}<br>${esc(p.invoice_id)}</span></td>
      <td><b>${esc((p.vendor_name||'').split(' ')[0])}</b><br><span style="color:var(--sub)">${esc(p.store_id)}</span></td>
      <td>${esc(p.brand||'')} ${esc(p.style_name||'')} <span style="color:var(--sub)">${esc(p.size||'')}</span></td>
      <td>${statusChip(p.variance_type)}</td>
      <td class="num">${fmt$(p.amt)}</td>
      <td class="num">${p.age_days}d</td>
      <td style="font-size:11.5px;color:var(--sub);max-width:240px">${esc(p.why)}${p.note?' — '+esc(p.note):''}<br><span style="color:#93a1bb">${esc(p.ai_suggested_resolution||'')}</span></td>
      <td style="font-size:12px">${p.assignee?esc(TEAM.find(t=>t.id===p.assignee)?.name||p.assignee):'—'}</td>
      <td>${statusChip(p.pile)}</td>
    </tr>`).join('');
    document.getElementById('mx-tbl').innerHTML=`<div class="tblwrap" style="max-height:520px"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend"><span>Showing ${fmtN(vis.length)} of ${fmtN(scoped().length)} in scope · a posted line is a NetSuite vendor bill / credit / pay-file flag, not a chart refresh.</span></div>`;
    document.getElementById('mx-all').onchange=e=>{ const on=e.target.checked; vis.forEach(p=>p.sel=on); render(); };
    document.querySelectorAll('#mx-tbl .mx-ck').forEach(ck=>{
      ck.onchange=()=>{ const id=ck.closest('tr').dataset.id; const p=queue.find(x=>x.id===id); if(p) p.sel=ck.checked; };
    });
    if(exportOpen) drawExport();
  }
  function selected(){ return visible().filter(p=>p.sel); }
  function act(fn, msg){
    const pick=selected();
    if(!pick.length){ document.getElementById('mx-act-msg').textContent='Select at least one exception.'; return; }
    pick.forEach(fn); pick.forEach(p=>p.sel=false);
    document.getElementById('mx-act-msg').textContent=msg(pick.length);
    render();
  }
  document.getElementById('mx-apply').onclick=()=>{
    const hits=scoped().filter(p=>p.pile!=='Posted' && matchesRule(p, ruleId));
    const r=RULES.find(x=>x.id===ruleId);
    hits.forEach(p=>{ p.pile=r.bucket; p.why=r.why; if(r.bucket!=='Assigned') p.assignee=''; });
    document.getElementById('mx-rule-msg').textContent=`Moved ${fmtN(hits.length)} matching lines → ${r.bucket}.`;
    tab=r.bucket; render();
  };
  document.getElementById('mx-reset').onclick=()=>{
    scoped().filter(p=>p.pile!=='Posted').forEach(p=>{ p.pile=p.engine; p.why=p.engineWhy; p.assignee=''; p.note=''; p.sel=false; });
    document.getElementById('mx-rule-msg').textContent='Restored engine recommendations.';
    tab='Clear'; render();
  };
  document.getElementById('mx-clear').onclick=()=>act(p=>{ p.pile='Clear'; p.why='AP cleared — accept / write off'; }, n=>`Cleared ${n}.`);
  document.getElementById('mx-debit').onclick=()=>act(p=>{ p.pile='Debit'; p.why='Recover with vendor credit'; }, n=>`Marked ${n} for debit.`);
  document.getElementById('mx-hold').onclick=()=>act(p=>{ p.pile='Hold'; p.why='Keep off the pay file'; p.assignee=''; }, n=>`Held ${n}.`);
  document.getElementById('mx-assign').onclick=()=>{
    const who=document.getElementById('mx-who').value, q=document.getElementById('mx-q').value.trim();
    if(!who){ document.getElementById('mx-act-msg').textContent='Pick a teammate first.'; return; }
    act(p=>{ p.pile='Assigned'; p.assignee=who; p.note=q; p.why='Handed off — '+q; }, n=>`Assigned ${n} to ${TEAM.find(t=>t.id===who).name}.`);
    tab='Assigned'; render();
  };
  document.getElementById('mx-ven').onchange=render;
  document.getElementById('mx-cause').onchange=render;

  const EXPORTS=[
    {id:'billcsv', title:'Vendor bill variance CSV', tag:'Download → NetSuite import',
      blurb:'Custom transaction CSV against vendor bill / item receipt. Cleared lines post as write-offs or accepted variances; debit lines as vendor credits. Fastest path for AP that already runs a saved CSV map.',
      file:'WW_NS_bill_variance.csv', kind:'csv'},
    {id:'rest', title:'NetSuite REST vendorBill / vendorCredit', tag:'System-to-system',
      blurb:'PATCH the bill, POST vendorCredit for debit memos, flag the payment hold. Token auth from this app. Human-approved in the queue first — the API is the last mile, not the decision.',
      file:'WW_NS_exception_payload.json', kind:'json'},
    {id:'edi812', title:'EDI X12 812 Credit/Debit Adjustment', tag:'Standard report form',
      blurb:'For Tier A vendors already on SPS. 812 (or 820 remittance advice with adjustment) so Carhartt / Wolverine see the same debit we posted in NetSuite. Closes the loop the 846/850 pipe started.',
      file:'WW_debit_812.edi.txt', kind:'edi'},
    {id:'cabinet', title:'File Cabinet + Map/Reduce', tag:'NetSuite-native job',
      blurb:'Drop the exception file; scheduled script creates credits, applies them to open bills, and writes a results CSV back. Fits IT-owned close calendars.',
      file:'WW_FileCabinet_exceptions.txt', kind:'csv'},
    {id:'payfile', title:'Pay-file hold report', tag:'Treasury / AP check run',
      blurb:'Statements on Hold stay off the check run. Clear-to-pay and pay-less-debits export as the NetSuite payment batch exception report. This is how analysis becomes “we did not overpay.”',
      file:'WW_payfile_holds.csv', kind:'csv'},
    {id:'pack', title:'Vendor debit packet', tag:'Portal / email pack',
      blurb:'PDF-ready CSV: PO, invoice, qty/cost delta, receiver. For vendors who will not take 812. NetSuite still gets the credit via CSV or REST so 3-way match has a closed line.',
      file:'WW_vendor_debit_pack.csv', kind:'csv'},
  ];
  function postable(){ return scoped().filter(p=>p.pile==='Clear'||p.pile==='Debit'||p.pile==='Hold'); }
  function csvFor(list){
    const cols=['match_id','action','po_id','invoice_id','vendor','store_id','sku','variance_type','amount','age_days','memo'];
    return [cols.join(',')].concat(list.map(p=>[p.id,p.pile,p.po_id,p.invoice_id,`"${p.vendor_name}"`,p.store_id,
      `"${(p.brand||'')+' '+(p.style_name||'')+' '+(p.size||'')}"`,p.variance_type,p.amt.toFixed(2),p.age_days,`"${(p.why||'').replace(/"/g,'')}"`].join(','))).join('\n');
  }
  function jsonFor(list){
    return JSON.stringify({source:'ww-merch-ops',anchor:ANCHOR, closeQueue:list.map(p=>({
      matchId:p.id, action:p.pile, po:p.po_id, invoice:p.invoice_id, vendor:p.vendor_name, amount:+p.amt.toFixed(2),
      netsuite: p.pile==='Clear'?'vendorBill.variance.accept': p.pile==='Debit'?'vendorCredit': 'vendorBill.paymentHold'
    }))}, null, 2);
  }
  function ediFor(list){
    const debits=list.filter(p=>p.pile==='Debit');
    const parts=['ISA*00*          *00*          *ZZ*WORKWORLD     *ZZ*NETSUITE      *260714*1200*U*00401*000000002*0*P*>~',
      'GS*CD*WORKWORLD*NETSUITE*20260714*1200*2*X*004010~','ST*812*0001~','BCD*20260714*WW-DBT-0714*00*C~'];
    debits.forEach(p=>parts.push(`CDD*01*${p.amt.toFixed(2)}**PO*${p.po_id}*IV*${p.invoice_id}~`));
    parts.push('SE*'+(4+debits.length)+'*0001~','GE*1*2~','IEA*1*000000002~');
    return parts.join('\n');
  }
  function payload(m, list){
    if(m.kind==='edi') return ediFor(list);
    if(m.kind==='json') return jsonFor(list);
    return csvFor(list);
  }
  function drawExport(){
    const card=document.getElementById('mx-export-card');
    card.style.display='';
    const n=postable().length;
    document.getElementById('mx-export-grid').innerHTML=EXPORTS.map(m=>`
      <button class="export-card ${exportMethod===m.id?'on':''}" data-x="${m.id}">
        <div class="xtag">${esc(m.tag)}</div>
        <h4>${esc(m.title)}</h4>
        <p>${esc(m.blurb)}</p>
      </button>`).join('')+
      `<div class="export-card muted"><div class="xtag">Same payload</div><h4>${fmtN(n)} decided lines</h4>
        <p>Clear + Debit + Hold only. Review and assigned stay here until someone acts. Posted lines are the operational effect — NetSuite AP and the pay file change.</p></div>`;
    document.querySelectorAll('#mx-export-grid .export-card[data-x]').forEach(b=>b.onclick=()=>{
      exportMethod=b.dataset.x; previewExport();
      document.querySelectorAll('#mx-export-grid .export-card').forEach(x=>x.classList.toggle('on', x.dataset.x===exportMethod));
    });
    if(exportMethod) previewExport();
    else document.getElementById('mx-export-preview').innerHTML='<div class="hint" style="margin-top:12px">Select a path to preview what NetSuite (or SPS / treasury) would ingest.</div>';
  }
  function previewExport(){
    const m=EXPORTS.find(x=>x.id===exportMethod);
    const list=postable();
    const body=payload(m, list);
    const mime=m.kind==='json'?'application/json': m.kind==='edi'?'text/plain':'text/csv';
    document.getElementById('mx-export-preview').innerHTML=`
      <div class="export-preview">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
          <b>${esc(m.title)}</b>
          <span class="chip blue">${fmtN(list.length)} lines</span>
          <button class="btn" id="mx-dl">Download ${esc(m.file)}</button>
          <button class="btn ghost" id="mx-mark">Mark as posted in NetSuite</button>
          <span id="mx-xmsg" style="font-size:12px;color:var(--sub)"></span>
        </div>
        <pre class="sqlbox" style="display:block;max-height:220px;overflow:auto">${esc(body.slice(0,3500))}${body.length>3500?'\n…':''}</pre>
      </div>`;
    document.getElementById('mx-dl').onclick=()=>{
      try{
        const blob=new Blob([body],{type:mime}); const a=document.createElement('a');
        a.href=URL.createObjectURL(blob); a.download=m.file; a.click();
        document.getElementById('mx-xmsg').textContent='Downloaded — AP drops this on the NetSuite / SPS side (demo file).';
      }catch(e){ document.getElementById('mx-xmsg').textContent='Download blocked in this view.'; }
    };
    document.getElementById('mx-mark').onclick=()=>{
      list.forEach(p=>{ p.pile='Posted'; p.why='Posted via '+m.title; p.sel=false; });
      document.getElementById('mx-xmsg').textContent='Clear / debit / hold marked posted. Review rows remain.';
      tab='Posted'; render();
    };
  }
  document.getElementById('mx-export').onclick=()=>{
    if(!postable().length){ document.getElementById('mx-act-msg').textContent='Nothing in Clear, Debit, or Hold yet.'; return; }
    exportOpen=true; drawExport();
    document.getElementById('mx-export-card').scrollIntoView({behavior:'smooth', block:'start'});
  };
  render();
},

async markdown(){
  const season=await runQ(`SELECT * FROM ${S}.markdown_season_v ORDER BY week_start`);
  const ladder=await runQ(`SELECT * FROM ${S}.markdown_ladder_v ORDER BY style_id, step_no`);
  const pols=await runQ(`SELECT * FROM ${S}.markdown_policy ORDER BY policy_id`);
  const exps=await runQ(`SELECT * FROM ${S}.experiments WHERE lower(hypothesis) LIKE '%markdown%' OR lower(hypothesis) LIKE '%rainwear%' ORDER BY exp_id`);
  const evts=await runQ(`SELECT * FROM ${S}.price_event_pipeline_v WHERE event_type='Markdown' ORDER BY effective_date`);
  const last=season[season.length-1];
  const mdSales=season.filter(r=>String(r.week_start)>='2026-06-15').reduce((a,r)=>a+ +r.net_sales,0);
  const floorBreaches=ladder.filter(r=>r.below_floor==='true').length;
  const evtOverdue=evts.filter(r=>r.workflow_state==='OVERDUE - not staged').length;
  const taskOverdue=evts.reduce((a,r)=>a+ +r.tasks_overdue,0);
  document.getElementById('md-kpis').innerHTML=[
    ['Season sell-through', last.cum_sell_through_pct+'%', fmtN(last.cum_units)+' of est '+fmtN(last.est_season_supply)+' units', +last.cum_sell_through_pct>=60?'good':'warn'],
    ['Active policies', pols.filter(p=>p.status==='Active').length, pols.filter(p=>p.status==='Testing').length+' in test (MD-004 delayed ladder)',''],
    ['Sales since step 1', fmt$(mdSales), 'rainwear, 6/15 markdown onward',''],
    ['Floor breaches in ladder', floorBreaches, 'deep steps priced below policy floor', floorBreaches?'warn':'good'],
    ['Events needing action', evtOverdue, 'markdown steps scheduled, not staged', evtOverdue?'bad':'good'],
    ['Label tasks overdue', taskOverdue, 'across markdown events', taskOverdue?'bad':'good'],
  ].map(k=>`<div class="kpi ${k[3]}"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
  // season chart
  const labels=season.map(r=>String(r.week_start).slice(0,10));
  const stepPts=season.map(r=>r.markdown_step? +r.cum_sell_through_pct : null);
  mkChart('ch-md-season','bar',{labels,datasets:[
    {label:'Weekly units',data:season.map(r=>+r.units),backgroundColor:'#9fb0cc',order:3},
    {label:'Cumulative sell-through %',type:'line',yAxisID:'y1',data:season.map(r=>+r.cum_sell_through_pct),borderColor:'#2E5BFF',borderWidth:2,pointRadius:0,tension:.25,order:1},
    {label:'Trigger: 60% by season wk 10',type:'line',yAxisID:'y1',data:season.map(()=>60),borderColor:'#1F2A44',borderDash:[6,4],borderWidth:1.2,pointRadius:0,order:2},
    {label:'Ladder steps',type:'line',yAxisID:'y1',data:stepPts,showLine:false,pointRadius:7,pointStyle:'rectRot',pointBackgroundColor:'#C55A11',borderColor:'#C55A11',order:0}]},
    {scales:{x:{ticks:{maxTicksLimit:12}},y:{title:{display:true,text:'units/wk'}},
      y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false},ticks:{callback:x=>x+'%'}}}});
  const steps=season.filter(r=>r.markdown_step);
  document.getElementById('md-season-note').innerHTML=steps.map(r=>`<span><span class="dot" style="background:#C55A11"></span><b>${String(r.week_start).slice(0,10)}</b> — ${esc(r.markdown_step)} at ${r.cum_sell_through_pct}% sell-through, realized price ${fmt$(r.realized_price)}</span>`).join(' · ');
  // ladder
  const styles=uniq(ladder.map(r=>r.style_id));
  document.getElementById('md-ladder-controls').innerHTML=`<div><label>Style</label><select id="md-style">${styles.map(s=>{const r=ladder.find(x=>x.style_id===s);return `<option value="${s}">${r.brand} ${r.style_name} (${r.policy_id})</option>`;}).join('')}</select></div>`;
  function renderLadder(){
    const rows=ladder.filter(r=>r.style_id===document.getElementById('md-style').value);
    mkChart('ch-md-ladder','bar',{labels:rows.map(r=>r.step_label+' — '+fmt$(r.step_price)),datasets:[
      {label:'Margin % at step',data:rows.map(r=>+r.step_margin_pct),
       backgroundColor:rows.map(r=>r.below_floor==='true'?'#C0392B':'#1E9E5A')},
      {label:'Policy floor '+rows[0].floor_margin_pct+'%',type:'line',data:rows.map(r=>+r.floor_margin_pct),borderColor:'#1F2A44',borderDash:[6,4],borderWidth:1.5,pointRadius:0}]},
      {plugins:{legend:{labels:{boxWidth:10}}},scales:{y:{title:{display:true,text:'margin %'}}}});
  }
  document.getElementById('md-style').onchange=renderLadder; renderLadder();
  // policies
  document.getElementById('md-policies').innerHTML=table(pols,[
    {h:'Policy',f:r=>`<span class="mono" style="font-size:11px">${esc(r.policy_id)}</span>`},
    {h:'Scope',k:'scope'},{h:'Trigger',k:'trigger'},
    {h:'Ladder',f:r=>`${esc(r.step_1)} → ${esc(r.step_2)} → ${esc(r.step_3)}`},
    {h:'Floor',f:r=>Math.round(r.floor_margin_pct*100)+'%',num:1},
    {h:'Status',f:r=>`<span class="chip ${r.status==='Active'?'green':'purple'}">${esc(r.status)}</span>`}]);
  // experiments
  document.getElementById('md-exps').innerHTML=exps.map(e=>`
    <div style="border:1px solid #E3EAF6;border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><span class="mono" style="font-size:11px;color:var(--blue)">${esc(e.exp_id)}</span>
      <span class="chip ${e.decision==='Rollout'?'green':e.decision==='Abandon'?'red':'blue'}">${esc(e.decision)}</span>
      <span style="color:var(--sub);font-size:11px">${esc(e.scope)}</span></div>
      <div style="font-size:13px;margin-bottom:4px"><b>${esc(e.hypothesis)}</b></div>
      <div style="font-size:12px;color:var(--sub)">Result: <b style="color:var(--txt)">${esc(e.result)}</b> · ${esc(e.ai_summary)}</div>
    </div>`).join('');
  // events
  document.getElementById('md-events').innerHTML=table(evts,[
    {h:'Event',f:r=>`<span class="mono" style="font-size:11px">${esc(r.event_id)}</span>`},
    {h:'Scope',k:'scope'},{h:'SKUs',k:'skus_affected',num:1},
    {h:'Effective',f:r=>String(r.effective_date).slice(0,10)},
    {h:'Workflow',f:r=>`<span class="chip ${({'Executed':'green','ERP updated':'blue','Announced':'gray','OVERDUE - not staged':'red'})[r.workflow_state]||'gray'}">${esc(r.workflow_state)}</span>`},
    {h:'Labels',f:r=>r.label_file_generated==='true'?'<span class="chip green">Generated</span>':'<span class="chip gray">Pending</span>'},
    {h:'Store tasks',f:r=>+r.tasks_total?`${r.tasks_done}/${r.tasks_total} done`+(+r.tasks_overdue?` · <span style="color:var(--red);font-weight:700">${r.tasks_overdue} overdue</span>`:''):'—'}]);
},
async pricing(){
  const pipe=await runQ(`SELECT * FROM ${S}.price_event_pipeline_v ORDER BY effective_date`);
  const upcoming=pipe.filter(r=>+r.days_to_effective>0);
  const overdue=pipe.filter(r=>r.workflow_state==='OVERDUE - not staged');
  const tOver=pipe.reduce((a,r)=>a+ +r.tasks_overdue,0);
  const impact=await runQ(`SELECT * FROM ${S}.price_impact_v ORDER BY annual_margin_delta DESC`);
  const annDelta=impact.reduce((a,r)=>a+ +r.annual_margin_delta,0);
  const pb=await runQ(`SELECT * FROM ${S}.prebuy_analysis_v ORDER BY prebuy_savings DESC`);
  const pbSav=pb.reduce((a,r)=>a+ +r.prebuy_savings,0), pbCash=pb.reduce((a,r)=>a+ +r.prebuy_cash_outlay,0);
  document.getElementById('pr-kpis').innerHTML=[
    ['Events in pipeline',pipe.length, upcoming.length+' upcoming · '+overdue.length+' overdue', overdue.length?'warn':''],
    ['Next effective', upcoming.length?String(upcoming[0].effective_date).slice(0,10):'—', upcoming.length?('in '+upcoming[0].days_to_effective+'d — '+upcoming[0].vendor_name):'', ''],
    ['SKUs touched', pipe.reduce((a,r)=>a+ +r.skus_affected,0), 'across all pipeline events', ''],
    ['Margin delta (8/1 staged)', fmt$(annDelta)+'/yr', 'retail +10% vs cost +5.5%', annDelta>0?'good':'bad'],
    ['Pre-buy on the table', fmt$(pbSav), 'on '+fmt$(pbCash)+' outlay · 6-wk guardrail', 'good'],
    ['Store tasks overdue', tOver, 'from price events', tOver?'bad':'good'],
  ].map(k=>`<div class="kpi ${k[3]}"><div class="lbl">${k[0]}</div><div class="val">${k[1]}</div><div class="sub">${k[2]}</div></div>`).join('');
  const wfChip=s=>({'Executed':'green','ERP updated':'blue','Announced':'gray','OVERDUE - not staged':'red'})[s]||'gray';
  document.getElementById('pr-pipe').innerHTML='<h3>Price &amp; promo event pipeline</h3><div class="hint">Announced → staged → ERP updated → stores notified → labels printed. Task rollup shows store execution.</div>'+table(pipe,[
    {h:'Event',f:r=>`<span class="mono" style="font-size:11px">${esc(r.event_id)}</span>`},
    {h:'Type',f:r=>`<span class="chip ${({VendorIncrease:'orange',Markdown:'purple',PromoStart:'blue',PromoEnd:'gray'})[r.event_type]||'gray'}">${esc(r.event_type)}</span>`},
    {h:'Vendor',f:r=>`<b>${esc(r.vendor_name)}</b>`},
    {h:'Scope',k:'scope'},
    {h:'SKUs',k:'skus_affected',num:1},
    {h:'Effective',f:r=>`${String(r.effective_date).slice(0,10)}<br><span style="color:var(--sub)">${+r.days_to_effective>0?('in '+r.days_to_effective+'d'):(-r.days_to_effective)+'d ago'}</span>`},
    {h:'Workflow',f:r=>`<span class="chip ${wfChip(r.workflow_state)}">${esc(r.workflow_state)}</span>`},
    {h:'Store tasks',f:r=>+r.tasks_total? `${r.tasks_done}/${r.tasks_total} done`+(+r.tasks_overdue?` · <span style="color:var(--red);font-weight:700">${r.tasks_overdue} overdue</span>`:'') : '—'},
    {h:'Comms',f:r=>`<span class="chip ${r.comm_status==='Sent'?'green':r.comm_status==='Not drafted'?'gray':'orange'}">${esc(r.comm_status)}</span>`}]);
  mkChart('ch-pr-impact','bar',{labels:impact.map(r=>r.style_name.length>22?r.style_name.slice(0,22)+'…':r.style_name),datasets:[
    {label:'Margin % today',data:impact.map(r=>+r.old_margin_pct),backgroundColor:'#9fb0cc'},
    {label:'Margin % after 8/1',data:impact.map(r=>+r.new_margin_pct),backgroundColor:'#1E9E5A'}]},
    {scales:{y:{title:{display:true,text:'margin %'}}}});
  document.getElementById('pr-impact-note').innerHTML=impact.map(r=>`<span><b>${esc(r.brand)} ${esc(r.style_name.split(' ')[0])}</b>: ${fmt$(r.old_cost)}→${fmt$(r.new_cost)} cost, ${fmt$(r.old_retail)}→${fmt$(r.new_retail)} retail, ${r.annual_margin_delta>=0?'+':''}${fmt$(r.annual_margin_delta)}/yr</span>`).join(' · ');
  const byV={};
  pb.forEach(r=>{byV[r.vendor_name]=byV[r.vendor_name]||{sav:0,cash:0,days:r.days_to_effective,pct:r.cost_increase_pct};byV[r.vendor_name].sav+=+r.prebuy_savings;byV[r.vendor_name].cash+=+r.prebuy_cash_outlay;});
  const vn=Object.keys(byV);
  mkChart('ch-pr-prebuy','bar',{labels:vn.map(v=>v.split(' ')[0]+' (+'+byV[v].pct+'% in '+byV[v].days+'d)'),datasets:[
    {label:'Cash outlay at today\'s cost',data:vn.map(v=>byV[v].cash),backgroundColor:'#9fb0cc'},
    {label:'Savings captured',data:vn.map(v=>byV[v].sav),backgroundColor:'#1E9E5A'}]},
    {scales:{y:{ticks:{callback:x=>'$'+fmtN(x)}}}});
  document.getElementById('pr-prebuy-note').innerHTML=`<span>Guardrail: pre-buy capped at 6 weeks of supply per style — beyond that, carrying cost and markdown risk eat the saving.</span>`;
  document.getElementById('pr-prebuy-tbl').innerHTML='<h3>Pre-buy detail by style</h3><div class="hint">Suggested quantity = 6 weeks of demand at current burn rate, priced at today\'s cost.</div>'+table(pb,[
    {h:'Vendor',f:r=>`<b>${esc(r.vendor_name)}</b><br><span style="color:var(--sub)">+${r.cost_increase_pct}% on ${String(r.effective_date).slice(5,10)}</span>`},
    {h:'Style',f:r=>`${esc(r.brand)} ${esc(r.style_name)}`},
    {h:'Wk units',k:'weekly_units',num:1},
    {h:'Cost',f:r=>fmt$(r.current_cost),num:1},
    {h:'Δ/unit',f:r=>'$'+Number(r.delta_per_unit).toFixed(2),num:1},
    {h:'Pre-buy qty',k:'suggested_prebuy_qty',num:1},
    {h:'Outlay',f:r=>fmt$(r.prebuy_cash_outlay),num:1},
    {h:'Savings',f:r=>`<b style="color:var(--green)">${fmt$(r.prebuy_savings)}</b>`,num:1}]);
  const src=await runQ(`SELECT CASE sophistication WHEN 'Tier A' THEN 'EDI 832 price/catalog' WHEN 'Tier B' THEN 'Portal download / RPA' ELSE 'Parsed email + confirm' END AS method, sophistication, count(*) n FROM ${S}.dim_vendor GROUP BY 1,2 ORDER BY 2`);
  document.getElementById('pr-sources').innerHTML=table(src,[
    {h:'Tier',k:'sophistication'},
    {h:'Ingestion method',f:r=>`<span class="chip ${r.sophistication==='Tier A'?'green':r.sophistication==='Tier B'?'blue':'orange'}">${esc(r.method)}</span>`},
    {h:'Vendors',k:'n',num:1}]);
},
async comms(){
  const s=await runQ(`SELECT status, count(*) n FROM ${S}.task_board_v GROUP BY 1 ORDER BY n DESC`);
  document.getElementById('c-kpis').innerHTML=s.map(r=>`<div class="kpi ${r.status==='Overdue'?'bad':''}"><div class="lbl">${esc(r.status)}</div><div class="val">${fmtN(r.n)}</div><div class="sub">store tasks</div></div>`).join('');
  const rows=await runQ(`SELECT * FROM ${S}.task_board_v WHERE status <> 'Done' ORDER BY CASE status WHEN 'Overdue' THEN 0 ELSE 1 END, due_date LIMIT 30`);
  document.getElementById('c-tbl').innerHTML='<h3>Open task board</h3><div class="hint">Overdue tasks escalate to the district manager — same alert pattern as the labor module.</div>'+table(rows,[
    {h:'Store',f:r=>`<b>${esc(r.store_id)}</b><br><span style="color:var(--sub)">${esc(r.store_name)}</span>`},
    {h:'Type',f:r=>`<span class="chip blue">${esc(r.task_type)}</span>`},
    {h:'Task',k:'title'},
    {h:'Due',f:r=>String(r.due_date).slice(0,10)},
    {h:'Status',f:r=>statusChip(r.status)}]);
},
async admin(){
  const rows=await runQ(`SELECT * FROM ${S}.data_health ORDER BY manually_managed DESC, table_name`);
  document.getElementById('a-tbl').innerHTML='<h3>Table registry &amp; feed freshness</h3><div class="hint">Orange = manually managed/seeded. Those tables are editable on the Reference tables page.</div>'+table(rows,[
    {h:'Table',f:r=>`<span class="mono" style="font-size:11.5px;${r.manually_managed==='true'?'color:var(--orange);font-weight:700':''}">${esc(r.table_name)}</span>`},
    {h:'Source',k:'source'},
    {h:'Manual',f:r=>r.manually_managed==='true'?'<span class="chip orange">MANUAL</span>':'<span class="chip green">FEED</span>'},
    {h:'Cadence',k:'refresh_cadence'},{h:'Owner',k:'owner'},
    {h:'Last load',f:r=>String(r.last_load_at).slice(0,16)}]);
},

async ask(){ askInit(); },
async refedit(){ await refInit(); },
};
// ================= Ask SolutionSet =================
const ASK_SCHEMA=`Catalog/schema: sset1000.supplychain  (always fully qualify: sset1000.supplychain.<view>)
Today's data anchor date is 2026-07-14. "Now"/"current" means that date.

GOVERNED VIEWS (query these):
sales_trend_v(week_start, net_sales, margin_dollars, units, rain_day_sales, promo_sales) -- weekly network totals, 52 weeks
kpi_summary_v(in_stock_pct, total_outs, meat_outs, inventory_turns, margin_pct, sales_30d, est_lost_sales_30d, auto_clear_pct, open_exceptions, open_exception_amt, replen_suggestions, expedite_checks, open_deals, open_deal_savings, open_tasks, overdue_tasks) -- ONE row, current state
store_variance_v(store_id, store_name, latitude, longitude, category, brand, size, actual_units, actual_sales, expected_units, variance_pct, positions, outs, meat_outs, lost_sales) -- last 8 weeks, one row per store x category x brand x size
replen_queue_v(suggestion_id, store_id, store_name, sku_id, brand, style_name, color, size, vendor_name, action, suggested_qty, proj_stockout_date, days_to_stockout, reason, tier_break_note, status)
size_run_health_v(store_id, style_id, brand, style_name, color, sizes_carried, sizes_out, meat_sizes_out, run_status, next_proj_stockout) -- run_status in (Intact, FringeBreak, MeatBreak)
size_demand_v(store_id, category, brand, size, actual_weekly_units, forecast_weekly_units, size_curve_share, meat_size)
demand_timeline_v(forecast_week, order_by_week, category, brand, vendor_name, store_id, climate_zone, forecast_units, forecast_cost, forecast_retail, weather_adj_units, weather_adj_cost, weather_adj_retail, weather_reactable, lead_days_p50)
forecast_summary_v(forecast_week, category, subcategory, forecast_units, weather_adj_units)
lead_time_variance_v(vendor_name, requested_ship, quoted_lead_days, actual_lead_days, variance_days) -- one row per PO receipt, 12 months
exception_queue_v(po_id, invoice_id, vendor_name, store_id, brand, style_name, size, variance_type, variance_amount, age_days, ai_suggested_resolution, status) -- open 3-way match exceptions
match_trend_v(match_month, variance_identified, variance_recovered, variance_open, auto_clear_pct)
statement_recon_v(master_statement_id, vendor_name, invoice_count, statement_total, open_exceptions, open_exception_amt, last_due, recon_status)
po_document_tree_v(master_po_id, po_id, store_id, store_name, vendor_name, master_order_date, po_type, po_status, qty_ordered, qty_received, qty_cancelled, po_value, receiver_id, receiver_status, received_date, invoice_id, invoice_total, invoice_status, master_statement_id, open_exceptions, open_exception_amt, total_exceptions, edi_855_ack)
po_lifecycle_v(po_id, vendor_name, status, past_requested_ship, open_value)
ats_coverage_v(vendor_id, vendor_name, sophistication, capture_method, items_reported, items_matched, match_rate_pct, zero_ats_items, earliest_next_avail)
deal_pipeline_v(opp_id, vendor_name, opp_type, description, commit_qty, savings_at_commit, margin_uplift_pct, est_weeks_of_supply, days_to_expiry, ai_recommendation, status)
price_event_pipeline_v(event_id, event_type, vendor_name, scope, skus_affected, effective_date, days_to_effective, workflow_state, erp_updated, stores_notified, label_file_generated, comm_status, comm_subject, tasks_total, tasks_done, tasks_overdue) -- event_type in (VendorIncrease, Markdown, PromoStart, PromoEnd)
price_impact_v(brand, style_name, old_cost, new_cost, old_retail, new_retail, old_margin_pct, new_margin_pct, annual_margin_delta)
prebuy_analysis_v(vendor_name, brand, style_name, weekly_units, current_cost, delta_per_unit, cost_increase_pct, effective_date, suggested_prebuy_qty, prebuy_cash_outlay, prebuy_savings)
markdown_season_v(week_start, units, net_sales, margin_dollars, cum_units, cum_sell_through_pct, est_season_supply, markdown_step, realized_price)
markdown_ladder_v(style_id, brand, style_name, category, subcategory, policy_id, policy_scope, step_no, step_label, regular_retail, step_price, disc_pct, base_cost, step_margin_pct, floor_margin_pct, below_floor)
task_board_v(task_id, store_id, store_name, task_type, title, related_event, due_date, status, completed_by, days_past_due)
data_health(table_name, source, manually_managed, refresh_cadence, owner, last_load_at)`;
const ASK_CHIPS=[
 'Which stores are furthest under plan, and in which categories?',
 'Where does the 4–10 day weather window hit stores already short on rain-lift categories?',
 'What are stockouts costing us right now?',
 'Which vendors run latest against their quoted lead times?',
 'Show open 3-way match exceptions by cause, with dollars and age.',
 'How has weekly margin % trended over the last 13 weeks?'];
let askBusy=false, askSeq=0;
function mdLite(t){
  const lines=String(t||'').replace(/\r/g,'').split('\n');
  let out='', inTbl=false, inList=false, buf=[];
  const inline=s=>esc(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/(^|[^*])\*([^*]+)\*/g,'$1<i>$2</i>');
  const flushTbl=()=>{ if(!buf.length) return;
    const rows=buf.map(l=>l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim()))
      .filter(r=>!r.every(c=>/^:?-{2,}:?$/.test(c)));
    const head=rows.shift()||[];
    out+='<table><thead><tr>'+head.map(h=>`<th>${inline(h)}</th>`).join('')+'</tr></thead><tbody>'+
      rows.map(r=>'<tr>'+r.map((c,i)=>`<td class="${i&&/^[-+$(]?[\d.,]/.test(c)?'num':''}">${inline(c)}</td>`).join('')+'</tr>').join('')+'</tbody></table>';
    buf=[]; };
  const closeList=()=>{ if(inList){ out+='</ul>'; inList=false; } };
  lines.forEach(raw=>{
    const l=raw.trim();
    if(l.startsWith('|')){ if(!inTbl){closeList(); inTbl=true;} buf.push(l); return; }
    if(inTbl){ flushTbl(); inTbl=false; }
    if(!l){ closeList(); return; }
    const h=l.match(/^(#{1,4})\s+(.*)$/);
    if(h){ closeList(); out+=`<h4>${inline(h[2])}</h4>`; return; }
    if(/^[-*]\s+/.test(l)){ if(!inList){out+='<ul>'; inList=true;} out+=`<li>${inline(l.replace(/^[-*]\s+/,''))}</li>`; return; }
    closeList(); out+=`<p>${inline(l)}</p>`;
  });
  if(inTbl) flushTbl();
  closeList();
  return out;
}
function askSanitize(sql){
  let s=String(sql||'').trim();
  s=s.replace(/^```[a-z]*\s*/i,'').replace(/```\s*$/,'').trim();
  s=s.replace(/;\s*$/,'').trim();
  if(!/^(select|with)\b/i.test(s)) throw new Error('The analyst returned something that is not a SELECT. Nothing was run.');
  if(/;/.test(s)) throw new Error('Only one statement is allowed. Nothing was run.');
  if(/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|refresh)\b/i.test(s))
    throw new Error('Write statements are blocked on this page. Nothing was run.');
  return s;
}
function askCSV(rows){
  if(!rows.length) return '';
  const cols=Object.keys(rows[0]);
  return [cols.join(',')].concat(rows.map(r=>cols.map(c=>{
    const v=r[c]==null?'':String(r[c]);
    return /[",\n]/.test(v)? '"'+v.replace(/"/g,'""')+'"' : v;
  }).join(','))).join('\n');
}
function askBubble(cls,who,html){
  const d=document.createElement('div');
  d.className='bub '+cls;
  d.innerHTML=`<div class="who">${who}</div><div class="body">${html}</div>`;
  document.getElementById('ask-thread').appendChild(d);
  d.scrollIntoView({behavior:'smooth',block:'nearest'});
  return d;
}
async function askSend(q){
  if(askBusy||!q.trim()) return;
  askBusy=true;
  const btn=document.getElementById('ask-send'); btn.disabled=true; btn.textContent='…';
  document.getElementById('ask-input').value='';
  askBubble('you','YOU',`<p>${esc(q)}</p>`);
  const ai=askBubble('ai','ANALYST','<div class="loading" style="padding:10px;text-align:left">{ WRITING THE QUERY }</div>');
  const body=ai.querySelector('.body');
  try{
    const sqlPrompt=`You are a SQL analyst for a retail merchandising application on Databricks SQL.
Write ONE Databricks SQL SELECT statement that answers the question below.

RULES
- Output ONLY the SQL. No prose, no markdown fences, no trailing semicolon.
- Fully qualify every table as sset1000.supplychain.<view>.
- Read-only: SELECT or WITH only. Never INSERT/UPDATE/DELETE/CREATE/DROP.
- Add a sensible LIMIT (<= 100) unless the question is an aggregate that returns few rows.
- Prefer readable aliases and rounded numbers (round(x,1) / round(x,0)).
- If the question needs a metric that is already a column in kpi_summary_v, use that view.

SCHEMA
${ASK_SCHEMA}

QUESTION
${q}`;
    let sqlRaw=await askLLM(sqlPrompt);
    if(sqlRaw&&typeof sqlRaw==='object') sqlRaw=sqlRaw.text??sqlRaw.content??JSON.stringify(sqlRaw);
    const sql=askSanitize(sqlRaw);
    body.innerHTML='<div class="loading" style="padding:10px;text-align:left">{ RUNNING AGAINST DATABRICKS }</div>';
    const rows=await runQ(sql);
    body.innerHTML='<div class="loading" style="padding:10px;text-align:left">{ READING THE RESULT }</div>';
    const sample=rows.slice(0,40);
    const narrPrompt=`You are a merchandising analyst talking to a retail executive at Work World, a workwear chain.
Answer the question using ONLY the query result provided. Be direct and specific: lead with the answer,
then give the two or three numbers that matter and what they imply for buying, inventory or margin.
Use a small markdown table when comparing more than two things. Keep it under 180 words.
Do not describe the SQL. Do not invent numbers that are not in the result.
If the result is empty, say so plainly and suggest how to rephrase.

QUESTION: ${q}

QUERY RESULT (${rows.length} row${rows.length===1?'':'s'}${rows.length>40?', first 40 shown':''}):
${JSON.stringify(sample)}`;
    let narr=await askLLM(narrPrompt);
    if(narr&&typeof narr==='object') narr=narr.text??narr.content??JSON.stringify(narr);
    const id='askres'+(++askSeq);
    const cols=rows.length?Object.keys(rows[0]):[];
    const tbl=rows.length? table(rows.slice(0,200),cols.map(c=>({h:c,k:c,num:rows.length&&/^[-+$(]?[\d.]+$/.test(String(rows[0][c]??''))}))) : '';
    body.innerHTML=mdLite(narr)+`
      <div class="resbar">
        <span class="rt" data-t="${id}">▸ Result set</span>
        <span class="rn">${rows.length} ROW${rows.length===1?'':'S'} · ${cols.length} COL${cols.length===1?'':'S'}</span>
        <span class="sp">
          <button data-sql="${id}">Show SQL</button>
          <button data-csv="${id}">CSV</button>
        </span>
      </div>
      <div class="sqlbox" id="sql-${id}">${esc(sql)}</div>
      <div id="tbl-${id}" style="display:none;margin-top:9px">${tbl}</div>`;
    body.querySelector('.rt').onclick=e=>{
      const t=document.getElementById('tbl-'+id); const open=t.style.display!=='none';
      t.style.display=open?'none':''; e.target.textContent=(open?'▸':'▾')+' Result set';
    };
    body.querySelector('[data-sql]').onclick=()=>{
      const b=document.getElementById('sql-'+id); b.style.display=b.style.display==='block'?'none':'block';
    };
    body.querySelector('[data-csv]').onclick=()=>{
      const csv=askCSV(rows);
      try{ const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a');
        a.href=URL.createObjectURL(blob); a.download='ask_solutionset_'+id+'.csv'; a.click();
      }catch(e){ navigator.clipboard&&navigator.clipboard.writeText(csv); }
    };
  }catch(e){
    body.innerHTML=`<p style="color:var(--red)"><b>That one did not land.</b></p><p style="font-size:12.5px;color:var(--sub)">${esc(e.message)}</p><p style="font-size:12.5px;color:var(--sub)">Try naming the view or the metric you have in mind — the analyst only sees the governed layer listed on the right.</p>`;
  }
  askBusy=false;
  const b2=document.getElementById('ask-send'); b2.disabled=false; b2.textContent='Send';
}
function askInit(){
  const thread=document.getElementById('ask-thread');
  thread.innerHTML='';
  askBubble('ai','ANALYST',mdLite(`I answer questions about Work World merchandising and operations by querying the governed layer directly — sales, inventory, forecasts, purchase orders, vendors, pricing and markdowns.

Ask in plain English. Every answer shows the SQL it ran and exports to CSV, so nothing here is a black box.`));
  document.getElementById('ask-chips').innerHTML=ASK_CHIPS.map(c=>`<button>${esc(c)}</button>`).join('');
  document.querySelectorAll('#ask-chips button').forEach(b=>b.onclick=()=>askSend(b.textContent));
  document.getElementById('ask-send').onclick=()=>askSend(document.getElementById('ask-input').value);
  document.getElementById('ask-new').onclick=()=>askInit();
  document.getElementById('ask-input').onkeydown=e=>{
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); askSend(e.target.value); }
  };
}
// ================= Reference table editor =================
const REF_TABLES=[
 {t:'size_curves', label:'Size curves', keys:['curve_id','size'], ro:['curve_name'],
  edit:{pct_units:'num', meat_size:'sel:true|false'}, order:'curve_id, size',
  note:'Share of units by size and which sizes count as “meat”. Drives size-run break detection, the size overlay on Demand Planning, and the size spread inside proposed POs. Reviewed quarterly by merch planning.'},
 {t:'markdown_policy', label:'Markdown policies', keys:['policy_id'], ro:[],
  edit:{scope:'text', trigger:'text', step_1:'text', step_2:'text', step_3:'text', floor_margin_pct:'num', status:'sel:Active|Testing|Retired'},
  order:'policy_id',
  note:'The markdown ladder itself: what triggers step 1, how far each step goes, and the margin floor the ladder is not allowed to breach. Owned by the merch director. Changing a floor changes what shows as a breach on the Markdown page.'},
 {t:'vendor_lead_times', label:'Vendor lead times & MOQ', keys:['vendor_id','category'],
  ro:['actual_lead_days_p50','actual_lead_days_p90','fill_rate_pct'],
  edit:{quoted_lead_days:'num', moq_units:'num', review_date:'date'}, order:'vendor_id, category',
  note:'Quoted lead time and MOQ are negotiated inputs you maintain; the P50/P90 actuals are computed from PO receipts and are read-only. The planning engine uses observed P50, so editing the quote changes the variance you see, not the plan.'},
 {t:'vendor_tier_pricing', label:'Vendor tier pricing', keys:['tier_id'], ro:['vendor_id','program','uom'],
  edit:{tier_min_qty:'num', tier_max_qty:'num', unit_price:'num', disc_vs_base_pct:'num', effective_start:'date', effective_end:'date'},
  order:'vendor_id, tier_min_qty',
  note:'Quantity break tables behind the "consolidate to the next tier" suggestions on Replenishment and the savings math on vendor deals.'},
 {t:'store_sku_params', label:'Store / SKU replen parameters', keys:['store_id','sku_id'], ro:['review_source','last_reviewed'],
  edit:{min_units:'num', max_units:'num', reorder_point:'num', safety_stock:'num', lead_time_days_override:'num'},
  order:'store_id, sku_id', limit:150,
  note:'Per-store min/max, reorder point and safety stock. These are the dials that decide when the replenishment queue fires. Showing the first 150 rows — the full table is edited in bulk via the change set.'},
 {t:'item_crossref', label:'Vendor item crossref', keys:['sku_id','vendor_id'], ro:['source'],
  edit:{vendor_style:'text', vendor_sku:'text', upc:'text'}, order:'sku_id', limit:150,
  note:'Maps our SKU to each vendor’s style/SKU/UPC. Unmatched rows are why vendor ATS coverage shows gaps — fixing a crossref here is the highest-leverage housekeeping on this page.'},
 {t:'dim_vendor', label:'Vendor master (app-owned fields)', keys:['vendor_id'], ro:['vendor_name','sophistication','edi_via_sps'],
  edit:{ats_method:'text', rep_name:'text', rep_email:'text', status:'sel:Active|Inactive'}, order:'vendor_id',
  note:'Name and EDI capability come from the ERP feed and are read-only here. Availability method and rep contact are maintained by merch ops — they drive how ATS is captured for each vendor.'},
];
const refEdits={};
const refKeyOf=(cfg,r)=>cfg.keys.map(k=>r[k]).join('~');
function refLit(v){
  if(v===''||v==null) return 'NULL';
  if(/^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
  if(/^(true|false)$/i.test(String(v))) return String(v).toLowerCase();
  return "'"+String(v).replace(/'/g,"''")+"'";
}
function refRender(){
  const n=Object.keys(refEdits).length;
  document.getElementById('ref-count').textContent=n;
  document.getElementById('ref-count').className='chip '+(n?'orange':'gray');
  ['ref-gen','ref-copy','ref-reset'].forEach(id=>document.getElementById(id).disabled=!n);
  const box=document.getElementById('ref-diff');
  if(!n){ box.innerHTML='<div class="loading" style="padding:16px">{ NO CHANGES STAGED }</div>'; return; }
  const byT={};
  Object.values(refEdits).forEach(e=>{ (byT[e.t]=byT[e.t]||[]).push(e); });
  box.innerHTML=Object.entries(byT).map(([t,es])=>{
    const cfg=REF_TABLES.find(x=>x.t===t);
    return `<div style="margin-bottom:12px"><div style="font-weight:700;font-size:13px;margin-bottom:5px">${cfg.label}
      <span class="mono" style="font-weight:400;color:var(--sub);font-size:11px">sset1000.supplychain.${t}</span>
      <span class="chip orange">${es.length}</span></div>
      <div class="difflist">`+es.map(e=>
      `<div>${cfg.keys.map((k,i)=>`<b>${k}</b>=${esc(e.keyvals[i])}`).join(' · ')} → <b>${e.col}</b>:
       <span class="o">${esc(e.old===''||e.old==null?'(null)':e.old)}</span> <span class="n">${esc(e.neu===''?'(null)':e.neu)}</span></div>`).join('')+
      `</div></div>`;
  }).join('');
}
function refSQL(){
  const lines=['-- Work World merchandising · reference-table change set',
    '-- generated '+new Date().toISOString().slice(0,19).replace('T',' ')+' from the Merchandising & Operations app',
    '-- review, then apply via SolutionSet. Nothing below has been executed.',''];
  Object.values(refEdits).forEach(e=>{
    const cfg=REF_TABLES.find(x=>x.t===e.t);
    const where=cfg.keys.map((k,i)=>`${k} = ${refLit(e.keyvals[i])}`).join(' AND ');
    lines.push(`UPDATE sset1000.supplychain.${e.t} SET ${e.col} = ${refLit(e.neu)} WHERE ${where};`);
  });
  return lines.join('\n');
}
async function refLoad(t){
  const cfg=REF_TABLES.find(x=>x.t===t);
  document.getElementById('ref-note').innerHTML=cfg.note;
  const host=document.getElementById('ref-table');
  host.innerHTML='<div class="loading">{ LOADING '+t.toUpperCase()+' }</div>';
  const rows=await runQ(`SELECT * FROM ${S}.${t} ORDER BY ${cfg.order}${cfg.limit?' LIMIT '+cfg.limit:''}`);
  const editCols=Object.keys(cfg.edit);
  const head=cfg.keys.map(k=>`<th>${k}</th>`).join('')+(cfg.ro||[]).map(k=>`<th>${k}</th>`).join('')+
    editCols.map(k=>`<th>${k} ✎</th>`).join('');
  const body=rows.map(r=>{
    const rk=refKeyOf(cfg,r);
    const keys=cfg.keys.map(k=>`<td class="key">${esc(r[k])}</td>`).join('');
    const ro=(cfg.ro||[]).map(k=>`<td class="ro">${esc(r[k]==null?'—':String(r[k]).length>19?String(r[k]).slice(0,19):r[k])}</td>`).join('');
    const ed=editCols.map(k=>{
      const kind=cfg.edit[k], cur=r[k]==null?'':String(r[k]);
      const eid=`${t}|${rk}|${k}`;
      const staged=refEdits[eid];
      const val=staged?staged.neu:cur;
      const dirty=staged?'dirty':'';
      if(kind.startsWith('sel:')){
        const opts=kind.slice(4).split('|');
        return `<td><select class="${dirty}" data-e="${esc(eid)}" data-o="${esc(cur)}">`+
          opts.map(o=>`<option ${o===val?'selected':''}>${o}</option>`).join('')+`</select></td>`;
      }
      const type=kind==='num'?'number':kind==='date'?'date':'text';
      const step=kind==='num'?' step="any"':'';
      return `<td><input class="${dirty}" type="${type}"${step} value="${esc(kind==='date'?String(val).slice(0,10):val)}" data-e="${esc(eid)}" data-o="${esc(cur)}"></td>`;
    }).join('');
    return `<tr>${keys}${ro}${ed}</tr>`;
  }).join('');
  host.innerHTML=`<div class="refwrap"><div class="tblwrap" style="max-height:480px"><table>
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="legend"><span>${rows.length} row${rows.length===1?'':'s'}${cfg.limit&&rows.length===cfg.limit?' (first '+cfg.limit+')':''}</span>
    <span>Columns marked ✎ are editable · keys and computed columns are locked</span></div></div>`;
  host.querySelectorAll('[data-e]').forEach(el=>{
    const commit=()=>{
      const id=el.dataset.e, old=el.dataset.o, neu=el.value;
      const [tt,rk,col]=id.split('|');
      if(String(neu)===String(old)){ delete refEdits[id]; el.classList.remove('dirty'); }
      else { refEdits[id]={t:tt, keyvals:rk.split('~'), col, old, neu}; el.classList.add('dirty'); }
      refRender();
    };
    el.onchange=commit; el.oninput=commit;
  });
}
async function refInit(){
  document.getElementById('ref-controls').innerHTML=
    `<div><label>Reference table</label><select id="ref-sel">`+
    REF_TABLES.map(c=>`<option value="${c.t}">${c.label}</option>`).join('')+`</select></div>`;
  document.getElementById('ref-sel').onchange=e=>refLoad(e.target.value).catch(err=>{
    document.getElementById('ref-table').innerHTML='<div class="err">'+esc(err.message)+'</div>';});
  document.getElementById('ref-gen').onclick=()=>{
    const t=document.getElementById('ref-sql'); t.style.display='block'; t.value=refSQL();
    document.getElementById('ref-msg').textContent='Change set generated below. Nothing has been executed.';
  };
  document.getElementById('ref-copy').onclick=async()=>{
    const sql=refSQL();
    try{ await navigator.clipboard.writeText(sql); document.getElementById('ref-msg').textContent='Change set copied — paste it to SolutionSet for review and apply.'; }
    catch(e){ const t=document.getElementById('ref-sql'); t.style.display='block'; t.value=sql; t.select();
      document.getElementById('ref-msg').textContent='Clipboard blocked — SQL shown below, select-all and copy.'; }
  };
  document.getElementById('ref-reset').onclick=()=>{
    Object.keys(refEdits).forEach(k=>delete refEdits[k]);
    document.getElementById('ref-sql').style.display='none';
    document.getElementById('ref-msg').textContent='All staged changes discarded.';
    refRender(); refLoad(document.getElementById('ref-sel').value);
  };
  refRender();
  await refLoad(REF_TABLES[0].t);
}
// ================= header freshness pills =================
const FRESH_MAP=[
 {t:'fact_sales_daily',      label:'POS sales (Shopify → NetSuite)'},
 {t:'fact_inventory_daily',  label:'Inventory positions (NetSuite)'},
 {t:'vendor_ats',            label:'Vendor ATS'},
 {t:'invoice_header',        label:'AP invoices (NetSuite)'},
];
async function freshness(){
  const el=document.getElementById('freshrow');
  try{
    const rows=await runQ(`SELECT table_name, refresh_cadence, last_load_at FROM ${S}.data_health`);
    const by={}; rows.forEach(r=>by[r.table_name]=r);
    const anchor=Date.parse(ANCHOR+'T23:59:59Z');
    const pills=FRESH_MAP.map(f=>{
      const r=by[f.t]; if(!r) return '';
      const d=String(r.last_load_at).slice(0,10);
      const days=Math.max(0,Math.round((anchor-Date.parse(d+'T00:00:00Z'))/86400000));
      const col=days<=1?'#3FCF8E':days<=7?'#F0B429':'#E4606D';
      const bad=days>7?' bad':'';
      const meta=days<=1? (r.refresh_cadence||'') : days+' day'+(days===1?'':'s')+' behind';
      const dt=new Date(d+'T00:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
      return `<div class="pill${bad}"><span class="pdot" style="background:${col}"></span>${f.label}: <b>${dt}</b><span class="meta">· ${meta}</span></div>`;
    }).filter(Boolean);
    el.innerHTML=pills.join('')||'<div class="pill"><span class="pdot" style="background:#8ea3cc"></span>No feed registry rows</div>';
  }catch(e){
    el.innerHTML='<div class="pill bad"><span class="pdot" style="background:#E4606D"></span>Feed status unavailable</div>';
  }
}
nav(); build(); show('ov-exec'); freshness();
