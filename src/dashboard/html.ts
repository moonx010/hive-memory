export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive Memory — Dashboard</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --orange: #d29922; --red: #f85149; --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); overflow: hidden; height: 100vh; }

  /* Auth overlay */
  #auth-overlay { position: fixed; inset: 0; background: var(--bg); z-index: 100;
    display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; }
  #auth-overlay.hidden { display: none; }
  #auth-overlay input { width: 360px; padding: 10px 14px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 14px; }
  #auth-overlay button { padding: 10px 24px; border-radius: 6px; border: none;
    background: var(--accent); color: #000; font-weight: 600; cursor: pointer; }
  #auth-overlay h2 { color: var(--text2); font-weight: 400; }

  /* Layout */
  header { height: 48px; background: var(--surface); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 16px; gap: 12px; }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); white-space: nowrap; }
  header select, header input { padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }
  .stats-bar { margin-left: auto; display: flex; gap: 16px; font-size: 12px; color: var(--text2); }
  .stats-bar span { font-weight: 600; color: var(--text); }

  #main { display: grid; grid-template-columns: 1fr 320px; height: calc(100vh - 48px); }
  #graph-panel { position: relative; overflow: hidden; }
  #graph-panel svg { width: 100%; height: 100%; }

  #sidebar { background: var(--surface); border-left: 1px solid var(--border);
    overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 20px; }

  .panel { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .panel h3 { font-size: 12px; text-transform: uppercase; color: var(--text2); margin-bottom: 10px; letter-spacing: 0.5px; }
  .panel svg { width: 100%; }

  /* Timeline */
  .timeline-date { font-size: 11px; color: var(--accent); margin: 8px 0 4px; font-weight: 600; }
  .timeline-item { font-size: 12px; color: var(--text2); padding: 3px 0; display: flex; gap: 6px; align-items: center; }
  .timeline-item .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .timeline-item .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Tooltip */
  .tooltip { position: absolute; background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px; font-size: 12px; pointer-events: none;
    max-width: 280px; z-index: 50; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
  .tooltip .tt-label { font-weight: 600; margin-bottom: 4px; }
  .tooltip .tt-meta { color: var(--text2); }

  /* Legend */
  .legend { display: flex; flex-wrap: wrap; gap: 8px; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text2); }
  .legend-item .swatch { width: 10px; height: 10px; border-radius: 2px; }

  /* Loading */
  .loading { display: flex; align-items: center; justify-content: center; height: 100%;
    color: var(--text2); font-size: 14px; }

  @media (max-width: 900px) {
    #main { grid-template-columns: 1fr; }
    #sidebar { max-height: 40vh; }
  }
</style>
</head>
<body>

<div id="auth-overlay">
  <h2>Hive Memory Dashboard</h2>
  <input id="token-input" type="password" placeholder="Bearer token" autofocus>
  <button onclick="doAuth()">Connect</button>
</div>

<header>
  <h1>Hive Memory</h1>
  <select id="filter-project"><option value="">All projects</option></select>
  <select id="filter-type"><option value="">All types</option></select>
  <select id="filter-namespace"><option value="">All namespaces</option></select>
  <div class="stats-bar">
    <div>Entities: <span id="stat-entities">-</span></div>
    <div>Synapses: <span id="stat-synapses">-</span></div>
    <div>Projects: <span id="stat-projects">-</span></div>
  </div>
</header>

<div id="main">
  <div id="graph-panel">
    <div class="loading" id="graph-loading">Loading graph...</div>
    <svg id="graph-svg"></svg>
    <div class="tooltip" id="tooltip" style="display:none"></div>
  </div>
  <div id="sidebar">
    <div class="panel" id="legend-panel"><h3>Entity Types</h3><div class="legend" id="legend"></div></div>
    <div class="panel" id="type-chart-panel"><h3>Distribution</h3><svg id="type-chart" height="160"></svg></div>
    <div class="panel" id="axon-chart-panel"><h3>Synapse Types</h3><svg id="axon-chart" height="120"></svg></div>
    <div class="panel" id="timeline-panel"><h3>Recent Activity</h3><div id="timeline"></div></div>
  </div>
</div>

<script>
let TOKEN = sessionStorage.getItem('hive_token') || '';
const TYPE_COLORS = {};
const color = d3.scaleOrdinal(d3.schemeTableau10);

function doAuth() {
  TOKEN = document.getElementById('token-input').value.trim();
  if (!TOKEN) return;
  sessionStorage.setItem('hive_token', TOKEN);
  document.getElementById('auth-overlay').classList.add('hidden');
  init();
}

if (TOKEN) {
  document.getElementById('auth-overlay').classList.add('hidden');
  init();
}

async function apiFetch(path) {
  const res = await fetch(path, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
  if (res.status === 401) {
    sessionStorage.removeItem('hive_token');
    document.getElementById('auth-overlay').classList.remove('hidden');
    throw new Error('Unauthorized');
  }
  return res.json();
}

async function init() {
  try {
    const [stats, graph, timeline] = await Promise.all([
      apiFetch('/api/stats'),
      apiFetch('/api/graph'),
      apiFetch('/api/timeline'),
    ]);
    renderStats(stats);
    renderGraph(graph);
    renderTimeline(timeline);
    populateFilters(stats);
  } catch (e) {
    console.error('Init failed:', e);
  }
}

function populateFilters(stats) {
  const pSel = document.getElementById('filter-project');
  for (const p of stats.byProject) {
    const opt = document.createElement('option');
    opt.value = p.key; opt.textContent = p.key + ' (' + p.count + ')';
    pSel.appendChild(opt);
  }
  const tSel = document.getElementById('filter-type');
  for (const t of stats.byType) {
    const opt = document.createElement('option');
    opt.value = t.key; opt.textContent = t.key + ' (' + t.count + ')';
    tSel.appendChild(opt);
  }
  const nSel = document.getElementById('filter-namespace');
  for (const n of stats.byNamespace) {
    const opt = document.createElement('option');
    opt.value = n.key; opt.textContent = n.key + ' (' + n.count + ')';
    nSel.appendChild(opt);
  }
  [pSel, tSel, nSel].forEach(el => el.addEventListener('change', reloadGraph));
}

async function reloadGraph() {
  const p = document.getElementById('filter-project').value;
  const t = document.getElementById('filter-type').value;
  const n = document.getElementById('filter-namespace').value;
  let url = '/api/graph?';
  if (p) url += 'project=' + encodeURIComponent(p) + '&';
  if (t) url += 'type=' + encodeURIComponent(t) + '&';
  if (n) url += 'namespace=' + encodeURIComponent(n) + '&';
  const graph = await apiFetch(url);
  renderGraph(graph);
}

function renderStats(stats) {
  document.getElementById('stat-entities').textContent = stats.totalEntities;
  document.getElementById('stat-synapses').textContent = stats.synapses.total;
  document.getElementById('stat-projects').textContent = stats.byProject.length;

  // Type distribution bar chart
  renderBarChart('#type-chart', stats.byType, d => color(d.key));

  // Axon distribution
  const axonColor = d3.scaleOrdinal(d3.schemePastel2);
  renderBarChart('#axon-chart', stats.synapses.byAxon.map(a => ({ key: a.axon, count: a.count })), d => axonColor(d.key));

  // Legend
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  const types = stats.byType.map(t => t.key);
  for (const t of types) {
    TYPE_COLORS[t] = color(t);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = '<div class="swatch" style="background:' + color(t) + '"></div>' + t;
    legend.appendChild(item);
  }
}

function renderBarChart(selector, data, colorFn) {
  const svg = d3.select(selector);
  svg.selectAll('*').remove();
  const width = 280, margin = { top: 4, right: 8, bottom: 4, left: 80 };
  const h = Math.max(data.length * 22, 40);
  svg.attr('height', h);

  const maxVal = d3.max(data, d => d.count) || 1;
  const y = d3.scaleBand().domain(data.map(d => d.key)).range([margin.top, h - margin.bottom]).padding(0.3);
  const x = d3.scaleLinear().domain([0, maxVal]).range([margin.left, width - margin.right]);

  svg.selectAll('rect')
    .data(data).enter().append('rect')
    .attr('y', d => y(d.key)).attr('x', margin.left)
    .attr('height', y.bandwidth())
    .attr('width', d => Math.max(x(d.count) - margin.left, 2))
    .attr('fill', d => colorFn(d))
    .attr('rx', 3);

  svg.selectAll('.label')
    .data(data).enter().append('text')
    .attr('y', d => y(d.key) + y.bandwidth() / 2 + 4)
    .attr('x', margin.left - 4)
    .attr('text-anchor', 'end')
    .attr('fill', '#8b949e').attr('font-size', 11)
    .text(d => d.key);

  svg.selectAll('.count')
    .data(data).enter().append('text')
    .attr('y', d => y(d.key) + y.bandwidth() / 2 + 4)
    .attr('x', d => Math.max(x(d.count), margin.left) + 4)
    .attr('fill', '#e6edf3').attr('font-size', 11)
    .text(d => d.count);
}

function renderGraph(data) {
  document.getElementById('graph-loading').style.display = 'none';
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  const panel = document.getElementById('graph-panel');
  const width = panel.clientWidth;
  const height = panel.clientHeight;
  svg.attr('viewBox', [0, 0, width, height]);

  if (data.nodes.length === 0) {
    svg.append('text').attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle').attr('fill', '#8b949e').attr('font-size', 14)
      .text('No entities found');
    return;
  }

  const g = svg.append('g');

  // Zoom
  svg.call(d3.zoom().scaleExtent([0.1, 8]).on('zoom', e => g.attr('transform', e.transform)));

  // Axon color
  const axonColor = d3.scaleOrdinal(d3.schemePastel2);

  const simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges).id(d => d.id).distance(80).strength(d => 0.1 + d.weight * 0.3))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(16));

  const link = g.append('g')
    .selectAll('line').data(data.edges).enter().append('line')
    .attr('stroke', d => axonColor(d.axon))
    .attr('stroke-width', d => 1 + d.weight * 4)
    .attr('stroke-opacity', 0.4);

  const node = g.append('g')
    .selectAll('circle').data(data.nodes).enter().append('circle')
    .attr('r', 7)
    .attr('fill', d => color(d.type))
    .attr('stroke', '#000').attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // Tooltip
  const tooltip = document.getElementById('tooltip');
  node.on('mouseover', (e, d) => {
    tooltip.style.display = 'block';
    tooltip.innerHTML = '<div class="tt-label">' + escHtml(d.label) + '</div>'
      + '<div class="tt-meta">Type: ' + d.type + '</div>'
      + (d.project ? '<div class="tt-meta">Project: ' + d.project + '</div>' : '')
      + '<div class="tt-meta">ID: ' + d.id.slice(0, 8) + '...</div>';
    const edges = data.edges.filter(e => e.source.id === d.id || e.target.id === d.id);
    if (edges.length > 0) {
      tooltip.innerHTML += '<div class="tt-meta" style="margin-top:4px">Connections: ' + edges.length + '</div>';
    }
  })
  .on('mousemove', e => {
    tooltip.style.left = (e.offsetX + 14) + 'px';
    tooltip.style.top = (e.offsetY + 14) + 'px';
  })
  .on('mouseout', () => { tooltip.style.display = 'none'; });

  // Click to highlight
  node.on('click', (e, d) => {
    const connected = new Set();
    connected.add(d.id);
    data.edges.forEach(e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      if (sid === d.id) connected.add(tid);
      if (tid === d.id) connected.add(sid);
    });
    node.attr('opacity', n => connected.has(n.id) ? 1 : 0.1);
    link.attr('stroke-opacity', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return (sid === d.id || tid === d.id) ? 0.8 : 0.05;
    });
  });

  // Click background to reset
  svg.on('click', e => {
    if (e.target === svg.node()) {
      node.attr('opacity', 1);
      link.attr('stroke-opacity', 0.4);
    }
  });

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node
      .attr('cx', d => d.x).attr('cy', d => d.y);
  });
}

function renderTimeline(data) {
  const container = document.getElementById('timeline');
  container.innerHTML = '';
  if (data.dates.length === 0) {
    container.innerHTML = '<div style="color:var(--text2);font-size:12px">No recent activity</div>';
    return;
  }
  for (const day of data.dates.slice(0, 7)) {
    const dateEl = document.createElement('div');
    dateEl.className = 'timeline-date';
    dateEl.textContent = day.date;
    container.appendChild(dateEl);
    for (const e of day.entities.slice(0, 8)) {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      item.innerHTML = '<div class="dot" style="background:' + color(e.type) + '"></div>'
        + '<div class="title">' + escHtml(e.title) + '</div>';
      container.appendChild(item);
    }
    if (day.entities.length > 8) {
      const more = document.createElement('div');
      more.className = 'timeline-item';
      more.style.color = 'var(--text2)';
      more.textContent = '  +' + (day.entities.length - 8) + ' more';
      container.appendChild(more);
    }
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
