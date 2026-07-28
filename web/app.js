let baseline;
const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);

async function boot(){
  const response = await fetch('../data/baseline.json');
  if(!response.ok) throw new Error(`Scenario load failed: ${response.status}`);
  baseline = await response.json();
  runScenario();
}

function evaluate(data){
  const horizon = data.meta.horizon_days, target = data.meta.target_builds;
  const parts = Object.fromEntries(data.parts.map(p => [p.id, {...p}]));
  const children = Object.fromEntries(data.bom.map(row => [row.parent_id, row.children]));
  const inbound = Object.fromEntries(data.parts.map(p => [p.id, 0]));
  const late = Object.fromEntries(data.parts.map(p => [p.id, 0]));
  for(const po of data.purchase_orders) (po.arrival_day <= horizon ? inbound : late)[po.part_id] += po.qty;
  const memo = {}, visiting = new Set();
  function solve(id){
    if(memo[id]) return memo[id];
    if(visiting.has(id)) throw new Error(`BOM cycle at ${id}`);
    visiting.add(id);
    const part = parts[id];
    if(!part) throw new Error(`Unknown part ${id}`);
    let result;
    if(!children[id]) result = {...part, usable:part.on_hand+inbound[id], available:part.on_hand+inbound[id], path:[id]};
    else {
      const candidates = children[id].map(c => ({child:solve(c.part_id), builds:Math.floor(solve(c.part_id).available/c.qty)}));
      const limiting = candidates.sort((a,b)=>a.builds-b.builds)[0];
      result = {...part, usable:part.on_hand+inbound[id], available:limiting.builds, path:[id,...limiting.child.path]};
    }
    visiting.delete(id); memo[id]=result; return result;
  }
  const root=solve('VEHICLE'), demand=Object.fromEntries(data.parts.map(p=>[p.id,0])); demand.VEHICLE=target;
  function propagate(id,units){for(const c of children[id]||[]){demand[c.part_id]+=units*c.qty;propagate(c.part_id,units*c.qty)}} propagate('VEHICLE',target);
  const constraints=[];
  for(const [id,required] of Object.entries(demand)){
    if(!required||children[id]) continue;
    const p=memo[id], shortage=Math.max(0,required-p.usable); if(!shortage) continue;
    const perBuild=required/target, buildGap=Math.ceil(shortage/perBuild), risk=Math.round((50*buildGap+20*(late[id]>0?1:0)+15*Math.min(p.lead_time_days/horizon,2))*10)/10;
    constraints.push({...p,required,shortage,buildGap,risk,late:late[id],action:late[id]>=shortage?`Evaluate expediting ${shortage.toLocaleString()} units inside day ${horizon}.`:`Validate a recovery source for ${shortage.toLocaleString()} units.`});
  }
  constraints.sort((a,b)=>b.risk-a.risk);
  return {root,constraints,summary:{target,ready:Math.min(target,root.available),gap:Math.max(0,target-root.available),value:constraints.reduce((s,c)=>s+c.shortage*c.unit_cost,0)},orders:data.purchase_orders,horizon,parts};
}

function runScenario(){
  const data=structuredClone(baseline);
  const day=Number($('tileArrival').value), engines=Number($('engineStock').value);
  data.purchase_orders.find(o=>o.part_id==='TPS-TILE').arrival_day=day;
  data.parts.find(p=>p.id==='ENGINE').on_hand=engines;
  const result=evaluate(data); render(result, day!==34||engines!==25);
}
function render(r, changed){
  $('scenarioState').textContent=changed?'WHAT-IF':'BASELINE';
  $('horizonLabel').textContent=`${r.horizon} DAYS`; $('readyBuilds').textContent=r.summary.ready; $('targetBuilds').textContent=r.summary.target;
  $('buildGap').textContent=r.summary.gap; $('constraintCount').textContent=r.constraints.length; $('riskValue').textContent=money(r.summary.value);
  $('readinessNote').textContent=r.summary.gap?`${r.summary.gap} build blocked by material timing`:'Target is feasible inside the horizon';
  $('pathBadge').textContent=`${r.root.path.length} LEVELS`;
  $('constraintList').innerHTML=r.constraints.length?r.constraints.map(c=>`<article class="constraint"><div class="risk-ring" aria-label="Risk score ${c.risk}">${c.risk}</div><div><h3>${c.name}</h3><p>${c.shortage.toLocaleString()} units short · ${c.lead_time_days}-day nominal lead<br>${c.action}</p></div><div class="impact"><b>−${c.buildGap}</b><span>BUILD IMPACT</span></div></article>`).join(''):`<div class="empty"><b>PLAN CLEARS</b><p>No leaf shortage blocks the target inside this horizon.</p></div>`;
  $('criticalPath').innerHTML=r.root.path.map((id,i)=>`<div class="path-node"><b>${r.parts[id].name}</b><span>${i===r.root.path.length-1?'LIMITING LEAF':`LEVEL ${i+1}`}</span></div>`).join('');
  $('ordersBody').innerHTML=r.orders.map(o=>{const p=r.parts[o.part_id],inside=o.arrival_day<=r.horizon;return `<tr><td>${o.id}</td><td>${p.name}</td><td>${o.qty.toLocaleString()}</td><td>DAY ${o.arrival_day}</td><td>${Math.round(o.confidence*100)}%</td><td><span class="tag ${inside?'':'late'}">${inside?'IN HORIZON':'TOO LATE'}</span></td></tr>`}).join('');
}
function reset(){ $('tileArrival').value=34; $('engineStock').value=25; syncOutputs(); runScenario(); }
function syncOutputs(){ $('tileDayOut').textContent=$('tileArrival').value; $('engineOut').textContent=$('engineStock').value; }
$('tileArrival').addEventListener('input',syncOutputs); $('engineStock').addEventListener('input',syncOutputs);
$('runBtn').addEventListener('click',runScenario); $('resetBtn').addEventListener('click',reset);
const dialog=$('methodDialog'); $('aboutBtn').addEventListener('click',()=>dialog.showModal()); dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());
boot().catch(err=>{$('constraintList').innerHTML=`<div class="empty"><b>MODEL LOAD FAILED</b><p>${err.message}. Serve from the project root with Python's HTTP server.</p></div>`;console.error(err)});
