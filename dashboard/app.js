// LaunchLens dashboard behaviour: render the board, filter/sort it, and show a detail view with the
// value breakdown and farm plan. Reads window.RADAR from data.js; no network, no framework.
'use strict';
(function () {
  var R = window.RADAR;
  if (!R) return;

  var $ = function (id) { return document.getElementById(id); };
  function usd(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function growth(g) {
    if (g == null) return { t: '—', c: 'g-flat' };
    var s = (g > 0 ? '+' : '') + g.toFixed(1) + '%';
    return { t: s, c: g > 0.5 ? 'g-up' : g < -0.5 ? 'g-dn' : 'g-flat' };
  }
  function ageText(d) { if (d == null) return 'unknown'; if (d < 60) return d + ' days'; if (d < 365) return Math.round(d / 30) + ' months'; return (d / 365).toFixed(1) + ' years'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Header stats + model note.
  $('s-total').textContent = (R.board_size + R.live_size + '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  $('s-watch').textContent = R.watchlist_size;
  $('s-board').textContent = R.board_size;
  $('s-asof').textContent = R.as_of;
  $('model-note').textContent = R.model_note + ' Sector multiple falls back to the global median (' + R.global_multiple + '×) when a category has fewer than three live comparables.';
  $('src').textContent = 'source: ' + (R.source || 'DefiLlama');

  // Sector multiples table.
  var st = $('sector-table');
  (R.sectors || []).forEach(function (s) {
    var d = document.createElement('div');
    d.className = 'sector-cell';
    d.innerHTML = '<div class="c">' + esc(s.category) + '</div><div class="m">' + s.multiple + '×</div><div class="n">' + s.comparables + ' live comparables</div>';
    st.appendChild(d);
  });

  // Category filter options.
  var cats = {};
  R.rows.forEach(function (r) { if (r.category) cats[r.category] = (cats[r.category] || 0) + 1; });
  var catSel = $('cat');
  var opt = document.createElement('option'); opt.value = ''; opt.textContent = 'All categories'; catSel.appendChild(opt);
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c + ' (' + cats[c] + ')'; catSel.appendChild(o);
  });

  var tbody = $('rows');
  var state = { q: '', cat: '', air: '', watch: false, sort: 'rank', active: null };

  function filtered() {
    var q = state.q.toLowerCase();
    var list = R.rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.air && r.airdrop_odds !== state.air) return false;
      if (state.watch && !r.on_watchlist) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var s = state.sort;
    list.sort(function (a, b) {
      if (s === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (s === 'growth') return (b.change_7d || -999) - (a.change_7d || -999);
      if (s === 'age') return (b.age_days || -1) - (a.age_days || -1);
      return a.rank - b.rank;
    });
    return list;
  }

  function render() {
    var list = filtered();
    $('count').textContent = list.length + ' of ' + R.rows.length + ' shown';
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var g = growth(r.change_7d);
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === state.active ? ' class="active"' : '') + '>' +
        '<td class="rk' + (r.rank <= 3 ? ' top' : '') + '">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.on_watchlist ? '<span class="wl" title="On the watchlist"></span>' : '') + '<br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="num iv">' + usd(r.implied_value_usd) + '</td>' +
        '<td class="num tvl">' + usd(r.tvl_usd) + '</td>' +
        '<td class="num ' + g.c + '">' + g.t + '</td>' +
        '<td><span class="pill ' + r.airdrop_odds + '">' + r.airdrop_odds + '</span></td>' +
        '</tr>';
    }
    tbody.innerHTML = html || '<tr><td colspan="7" style="padding:22px;color:var(--faint)">No protocol matches these filters.</td></tr>';
    if (list.length && (!state.active || !list.some(function (r) { return r.slug === state.active; }))) {
      showDetail(list[0].slug);
    }
  }

  function showDetail(slug) {
    var r = R.rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    state.active = slug;
    var g = growth(r.change_7d);
    var steps = (r.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('detail').innerHTML =
      '<div class="big-label">Implied value &middot; rank #' + r.rank + '</div>' +
      '<div class="big">' + usd(r.implied_value_usd) + '</div>' +
      '<h3>' + esc(r.name) + (r.on_watchlist ? ' <span class="wl" title="On the watchlist"></span>' : '') + '</h3>' +
      '<p class="d-sub">' + esc(r.category || 'Uncategorised') + ' &middot; ' + esc((r.chains || []).join(', ') || '—') + '</p>' +
      '<div class="facts">' +
        fact('TVL', usd(r.tvl_usd)) +
        fact('7-day change', g.t) +
        fact('Age, no token', ageText(r.age_days)) +
        fact('Airdrop odds', r.airdrop_odds) +
      '</div>' +
      '<div class="breakdown">' +
        bd('Sector multiple', r.sector_multiple + '× ' + (r.sector_source === 'global' ? '(global)' : '(sector)')) +
        bd('Momentum factor', r.momentum + '×') +
        bd('Timing factor', r.timing + '×') +
        bd('Conviction', r.conviction + '×') +
      '</div>' +
      '<div class="plan-h">How to farm it</div>' +
      '<ol class="plan">' + steps + '</ol>';
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('active', rows[i].getAttribute('data-slug') === slug);
  }
  function fact(k, v) { return '<div class="fact"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>'; }
  function bd(k, v) { return '<div class="row"><span>' + k + '</span><span>' + esc(v) + '</span></div>'; }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (tr && tr.getAttribute('data-slug')) showDetail(tr.getAttribute('data-slug'));
  });
  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  $('air').addEventListener('change', function (e) { state.air = e.target.value; render(); });
  $('watchonly').addEventListener('change', function (e) { state.watch = e.target.checked; render(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });

  // Deep links so a view can be shared or reproduced: #slug=<slug> selects a protocol;
  // #air=High (etc.) and #watch=1 preset the filters. Read once on load.
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (kv) {
      var p = kv.split('='); var k = p[0]; var v = decodeURIComponent(p[1] || '');
      if (k === 'air') { state.air = v; $('air').value = v; }
      else if (k === 'cat') { state.cat = v; $('cat').value = v; }
      else if (k === 'watch') { state.watch = v === '1'; $('watchonly').checked = state.watch; }
      else if (k === 'q') { state.q = v; $('q').value = v; }
    });
  }
  applyHash();
  render();
  var sel = (location.hash || '').match(/slug=([^&]+)/);
  if (sel) showDetail(decodeURIComponent(sel[1]));
})();
