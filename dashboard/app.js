// LaunchLens v3 dashboard behaviour. Reads window.RADAR from zdata.js; no network, no framework.
'use strict';
(function () {
  var R = window.RADAR;
  if (!R) return;
  var $ = function (id) { return document.getElementById(id); };
  function usd(n) {
    if (n == null) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function growth(g) {
    if (g == null) return { t: '—', c: 'g-flat' };
    return { t: (g > 0 ? '+' : '') + g.toFixed(1) + '%', c: g > 0.5 ? 'g-up' : g < -0.5 ? 'g-dn' : 'g-flat' };
  }
  function ageText(d) { if (d == null) return 'unknown'; if (d < 60) return d + ' days'; if (d < 365) return Math.round(d / 30) + ' months'; return (d / 365).toFixed(1) + ' years'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Header telemetry
  var fmtInt = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  $('s-total').textContent = fmtInt(R.audit.total_protocols);
  $('s-live-sub').textContent = R.audit.live_families + ' live families';
  $('s-watch').textContent = R.watchlist_size + ' / ' + R.watchlist_size;
  $('s-board').textContent = R.board_size;
  $('s-cap-sub').textContent = usd(R.total_implied_usd) + ' implied';
  $('s-bt').textContent = R.backtest.within_2x_pct + '%';
  $('s-bt-sub').textContent = 'ρ ' + R.backtest.spearman.toFixed(2) + ' · n=' + R.backtest.n;
  $('s-beta').textContent = 'β ' + R.curve.beta.toFixed(3);
  $('s-glob-sub').textContent = 'global med ' + R.global_multiple.toFixed(4) + '×';
  $('s-asof').textContent = R.as_of;
  $('src').textContent = 'source: ' + (R.source || 'DefiLlama');
  $('tab-c-board').textContent = R.rows.length;
  $('tab-c-comps').textContent = R.live.length;
  $('tab-c-audit').textContent = R.audit_rows.length;

  // Backtest badges
  $('bt-badges').innerHTML =
    btp('LOO-CV', R.backtest.n + ' families') +
    btp('within 2×', '<b>' + R.backtest.within_2x_pct + '%</b>') +
    btp('within 3×', '<b>' + R.backtest.within_3x_pct + '%</b>') +
    btp('rank ρ', '<b>' + R.backtest.spearman.toFixed(3) + '</b>') +
    btp('median err', R.backtest.median_ratio_err + '×');
  function btp(k, v) { return '<span class="bt-pill">' + k + ' ' + v + '</span>'; }

  // Sector grid (clickable to filter)
  var st = $('sector-table');
  st.innerHTML = R.sectors.map(function (s) {
    return '<div class="sector-cell" data-cat="' + esc(s.category) + '">' +
      '<div class="c" title="' + esc(s.category) + '">' + esc(s.category) + '</div>' +
      '<div class="m-row"><span class="m">' + s.multiple.toFixed(2) + '×</span><span class="raw">raw ' + s.raw.toFixed(2) + '×</span></div>' +
      '<div class="n">' + s.comparables + ' comps · w' + s.weight.toFixed(2) + ' · P25–75 ' + s.p25.toFixed(2) + '–' + s.p75.toFixed(2) + '</div>' +
      '</div>';
  }).join('');

  // Comps + audit panes
  $('bt-summary').innerHTML =
    ac('Live families', R.audit.live_families, 'deduplicated tokens') +
    ac('LOO-CV within 2×', R.backtest.within_2x_pct + '%', 'within 3×: ' + R.backtest.within_3x_pct + '%') +
    ac('Rank correlation', R.backtest.spearman.toFixed(3), 'Spearman ρ, pred vs actual') +
    ac('Median error', R.backtest.median_ratio_err + '×', 'out-of-sample mcap') +
    ac('Power law', 'β ' + R.curve.beta.toFixed(3), 'mcap ∝ TVL^β');
  $('audit-summary').innerHTML =
    ac('Total protocols', fmtInt(R.audit.total_protocols), 'in the snapshot') +
    ac('Live-token', R.audit.live_token, R.audit.live_families + ' families') +
    ac('Pre-token', R.audit.pre_token, 'no token recorded') +
    ac('Watchlist', R.audit.watchlist, '100% covered') +
    ac('Ranked', R.audit.ranked, 'on the board');
  function ac(k, v, s) { return '<div class="ac"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + esc(s) + '</div></div>'; }

  $('live-rows').innerHTML = R.live.map(function (f) {
    var g = growth(f.change_7d);
    return '<tr><td><span class="pname">' + esc(f.name) + '</span>' + (f.sub_protocols > 1 ? '<span class="psub">' + f.sub_protocols + ' pools</span>' : '') + '</td>' +
      '<td class="cat">' + esc(f.category || '—') + '</td><td class="cat">' + esc((f.chains || []).slice(0, 2).join(', ')) + '</td>' +
      '<td class="num tvl">' + usd(f.tvl_usd) + '</td><td class="num iv">' + usd(f.mcap_usd) + '</td>' +
      '<td class="num mult">' + (f.mcap_to_tvl != null ? f.mcap_to_tvl.toFixed(2) + '×' : '—') + '</td>' +
      '<td class="num tvl">' + usd(f.pred_mcap_usd) + '</td></tr>';
  }).join('');

  $('audit-rows').innerHTML = R.audit_rows.map(function (a) {
    return '<tr><td><span class="pname">' + esc(a.name) + '</span></td><td class="psub">' + esc(a.slug) + '</td>' +
      '<td class="cat">' + esc(a.category || '—') + '</td><td class="num tvl">' + usd(a.tvl_usd) + '</td>' +
      '<td class="cat">' + esc(a.reason) + '</td></tr>';
  }).join('');

  // Category + chain filters
  var cats = {}, chains = {};
  R.rows.forEach(function (r) { if (r.category) cats[r.category] = (cats[r.category] || 0) + 1; (r.chains || []).forEach(function (c) { chains[c] = (chains[c] || 0) + 1; }); });
  fill($('cat'), 'All categories', cats);
  fill($('chain'), 'All chains', chains);
  function fill(sel, allLabel, counts) {
    var o = document.createElement('option'); o.value = ''; o.textContent = allLabel + ' (' + Object.keys(counts).length + ')'; sel.appendChild(o);
    Object.keys(counts).sort().forEach(function (c) { var x = document.createElement('option'); x.value = c; x.textContent = c + ' (' + counts[c] + ')'; sel.appendChild(x); });
  }

  var tbody = $('rows');
  var state = { q: '', cat: '', chain: '', air: '', verdict: '', watch: false, sort: 'rank', active: null };

  function filtered() {
    var q = state.q.toLowerCase();
    var list = R.rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) === -1) return false;
      if (state.air && r.airdrop_odds !== state.air) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.watch && !r.on_watchlist) return false;
      if (q) { var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
      return true;
    });
    var s = state.sort;
    list.sort(function (a, b) {
      if (s === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (s === 'growth') return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d);
      if (s === 'age') return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days);
      if (s === 'mult') return b.multiple - a.multiple;
      return a.rank - b.rank;
    });
    return list;
  }

  function vClass(v) { return v === 'Priority Farm' ? 'v-priority' : v === 'Active Farm' ? 'v-active' : ''; }

  function render() {
    var list = filtered();
    $('count').textContent = list.length + ' of ' + R.rows.length + ' shown';
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i], g = growth(r.change_7d);
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === state.active ? ' class="active"' : '') + '>' +
        '<td class="rk' + (r.rank <= 3 ? ' top' : '') + '">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.on_watchlist ? '<span class="wl">WATCH</span>' : '') + '<div class="psub">' + esc((r.chains || []).slice(0, 3).join(', ')) + ((r.chains || []).length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div></td>' +
        '<td><span class="cat">' + esc(r.category || '—') + '</span><div class="grade">Grade ' + r.confidence + '</div></td>' +
        '<td class="num"><span class="iv">' + usd(r.implied_value_usd) + '</span><div class="band">' + usd(r.implied_p25_usd) + '–' + usd(r.implied_p75_usd) + '</div></td>' +
        '<td class="num"><span class="tvl">' + usd(r.tvl_usd) + '</span><div class="mult">' + r.multiple.toFixed(2) + '× ' + (r.source === 'global' ? 'glob' : 'sect') + '</div></td>' +
        '<td class="num ' + g.c + '">' + g.t + '</td>' +
        '<td><span class="pill ' + r.airdrop_odds + '">' + r.airdrop_odds + '</span><div class="verdict ' + vClass(r.verdict) + '">' + r.verdict + '</div></td>' +
        '</tr>';
    }
    tbody.innerHTML = html || '<tr><td colspan="7" style="padding:22px;color:var(--faint)">No protocol matches these filters.</td></tr>';
    if (list.length && (!state.active || !list.some(function (r) { return r.slug === state.active; }))) showDetail(list[0].slug);
  }

  function showDetail(slug) {
    var r = R.rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    state.active = slug;
    var g = growth(r.change_7d);
    var lo = r.implied_p25_usd, hi = r.implied_p75_usd, mid = r.implied_value_usd;
    var pos = hi > lo ? Math.round(((mid - lo) / (hi - lo)) * 100) : 50;
    var steps = (r.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('detail').innerHTML =
      '<div class="d-head"><span class="d-rank">Rank #' + r.rank + (r.on_watchlist ? ' · watchlist' : '') + '</span>' +
        '<span class="d-badges"><span class="d-grade">Confidence ' + r.confidence + '</span><span class="d-grade" style="color:var(--accent);border-color:rgba(255,46,154,0.4)">' + r.verdict + '</span></span></div>' +
      '<h3>' + esc(r.name) + '</h3>' +
      '<p class="d-sub">' + esc(r.category || 'Uncategorised') + ' · pre-token · age ' + ageText(r.age_days) + '</p>' +
      '<div class="chainset">' + (r.chains || []).map(function (c) { return '<span class="chip-chain">' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="d-value"><span class="big">' + usd(mid) + '</span><span class="big-sub">' + r.multiple.toFixed(2) + '× eff. multiple</span>' +
        '<div class="bandbar" style="--pos:' + pos + '%"></div>' +
        '<div class="band-labels"><span>Bear P25 ' + usd(lo) + '</span><span>Bull P75 ' + usd(hi) + '</span></div></div>' +
      '<div class="breakdown">' +
        bd('Sector multiple', r.sector_multiple.toFixed(3) + '× (' + (r.source === 'global' ? 'global' : 'category, ' + r.comparables + ' comps') + ')') +
        bd('Size-curve multiple', r.size_multiple.toFixed(3) + '×') +
        bd('Blended multiple', r.multiple.toFixed(3) + '×') +
        bd('7-day momentum', r.momentum.toFixed(3) + '× (' + g.t + ')') +
        bd('Token-timing', r.timing.toFixed(3) + '×') +
        bd('Conviction', r.conviction.toFixed(2) + '×') +
        bd('TVL', usd(r.tvl_usd)) +
      '</div>' +
      '<div class="plan-h">How to farm it — costed playbook</div><ol class="plan">' + steps + '</ol>';
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('active', rows[i].getAttribute('data-slug') === slug);
  }
  function bd(k, v) { return '<div class="row"><span>' + k + '</span><span>' + esc(v) + '</span></div>'; }

  // Tabs
  var tabs = document.querySelectorAll('.tab-btn');
  var controls = $('controls-bar');
  for (var t = 0; t < tabs.length; t++) tabs[t].addEventListener('click', function (e) {
    var tab = e.currentTarget.getAttribute('data-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i] === e.currentTarget);
    $('view-board').classList.toggle('hidden', tab !== 'board');
    $('view-comps').classList.toggle('hidden', tab !== 'comps');
    $('view-audit').classList.toggle('hidden', tab !== 'audit');
    controls.style.display = tab === 'board' ? '' : 'none';
  });

  // Events
  tbody.addEventListener('click', function (e) { var tr = e.target.closest('tr'); if (tr && tr.getAttribute('data-slug')) showDetail(tr.getAttribute('data-slug')); });
  st.addEventListener('click', function (e) {
    var cell = e.target.closest('.sector-cell'); if (!cell) return;
    var cat = cell.getAttribute('data-cat');
    state.cat = state.cat === cat ? '' : cat; $('cat').value = state.cat;
    var cells = st.querySelectorAll('.sector-cell'); for (var i = 0; i < cells.length; i++) cells[i].classList.toggle('active-sec', cells[i] === cell && state.cat);
    render();
  });
  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; render(); });
  $('air').addEventListener('change', function (e) { state.air = e.target.value; render(); });
  $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; render(); });
  $('watchonly').addEventListener('change', function (e) { state.watch = e.target.checked; render(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  $('btn-reset').addEventListener('click', function () {
    state.q = state.cat = state.chain = state.air = state.verdict = ''; state.watch = false; state.sort = 'rank';
    $('q').value = ''; $('cat').value = ''; $('chain').value = ''; $('air').value = ''; $('verdict').value = ''; $('watchonly').checked = false; $('sort').value = 'rank';
    var cells = st.querySelectorAll('.sector-cell'); for (var i = 0; i < cells.length; i++) cells[i].classList.remove('active-sec');
    render();
  });
  $('btn-export').addEventListener('click', function () {
    var list = filtered();
    var head = ['rank', 'slug', 'name', 'category', 'chains', 'tvl_usd', 'implied_value_usd', 'implied_p25_usd', 'implied_p75_usd', 'effective_multiple', 'airdrop_odds', 'verdict', 'confidence', 'on_watchlist'];
    var lines = [head.join(',')];
    list.forEach(function (r) {
      lines.push([r.rank, r.slug, '"' + String(r.name).replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', '"' + (r.chains || []).join('|') + '"', r.tvl_usd, r.implied_value_usd, r.implied_p25_usd, r.implied_p75_usd, r.multiple, r.airdrop_odds, '"' + r.verdict + '"', r.confidence, r.on_watchlist].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'launchlens-board.csv'; a.click();
    toast(list.length + ' rows exported to CSV');
  });
  function toast(msg) { var el = $('toast'); el.textContent = msg; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2200); }

  // Deep links: #slug=, #cat=, #air=, #verdict=, #watch=1, #tab=
  (function applyHash() {
    var h = (location.hash || '').replace(/^#/, ''); if (!h) return;
    h.split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = decodeURIComponent(p[1] || '');
      if (k === 'cat') { state.cat = v; $('cat').value = v; }
      else if (k === 'air') { state.air = v; $('air').value = v; }
      else if (k === 'verdict') { state.verdict = v; $('verdict').value = v; }
      else if (k === 'watch') { state.watch = v === '1'; $('watchonly').checked = state.watch; }
      else if (k === 'q') { state.q = v; $('q').value = v; }
      else if (k === 'tab') { var b = document.querySelector('.tab-btn[data-tab="' + v + '"]'); if (b) b.click(); }
    });
  })();
  render();
  var sel = (location.hash || '').match(/slug=([^&]+)/);
  if (sel) showDetail(decodeURIComponent(sel[1]));
})();
