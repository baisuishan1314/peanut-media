/**
 * 花生传媒 Peanut Media — Frontend Engine v2
 * Architecture: Data Layer -> Render Layer -> Event Layer
 * No globals, no leaks, proper error boundaries.
 */
(() => {
'use strict';

// ===== CONFIG =====
const CONFIG = {
  DATA_JSON: 'data.json',
  REFRESH_MS: 30 * 60 * 1000 // 30 min — RCU data synced by GitHub Actions
};

// ===== STATE =====
const state = {
  data: null,
  source: 'fallback',  // 'fallback' | 'data-json'
  refreshTimer: null,
  isLoading: false,
  firstRender: true,   // only apply .reveal animation on first render
  filter: { player: 'all', rank: 'all' },  // result filter state
  page: 1,
  pageSize: 10
};

// ===== UTILS =====
const Utils = {
  ptSign(v) { return v > 0 ? '+' : ''; },
  ptClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; },
  scoreClass(rank) { return rank === 1 ? 'good' : rank === 2 ? 'ok' : rank === 4 ? 'bad' : ''; },
  escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  },
  formatScore(s) {
    return (s >= 0 ? '+' : '') + s.toLocaleString();
  },
  roundTo1(v) { return Math.round(v * 10) / 10; },
  roundNum(str) { return parseInt(String(str).replace(/[^0-9]/g, '')) || 0; },
  todayStr() {
    const now = new Date();
    return now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
  }
};

// ===== CHARTS (pure SVG, no dependencies) =====
const Charts = {
  /** Donut chart showing rank distribution (1st/2nd/3rd/4th) */
  donut(wins, s2, s3, s4, size = 56) {
    const total = wins + s2 + s3 + s4;
    if (total === 0) return '<div class="donut-empty">暂无数据</div>';
    const colors = ['#D4AF37', '#c0c0c0', '#cd7f32', '#C41E3A'];
    const labels = ['1位', '2位', '3位', '4位'];
    const values = [wins, s2, s3, s4];
    const r = (size - 8) / 2;
    const cx = size / 2, cy = size / 2;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    let segments = '';
    let legend = '';
    values.forEach((v, i) => {
      if (v > 0) {
        const len = (v / total) * circumference;
        segments += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i]}" stroke-width="5" stroke-dasharray="${len.toFixed(1)} ${(circumference - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
        offset += len;
      }
      const pct = total > 0 ? Math.round(v / total * 100) : 0;
      legend += `<div class="donut-leg-item"><span class="donut-leg-dot" style="background:${colors[i]}"></span>${labels[i]} ${v} (${pct}%)</div>`;
    });
    return `<div class="donut-wrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut-chart">${segments}<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${Math.round(size * 0.24)}" font-weight="800" fill="#eaecf0">${total}</text></svg><div class="donut-legend">${legend}</div></div>`;
  }
};

// ===== DOM HELPERS =====
const $ = id => document.getElementById(id);
function setHTML(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

// ===== DATA LAYER =====
const Data = {
  /** Read inline fallback JSON from <script type="application/json"> */
  getFallback() {
    try {
      const el = $('fallback-data');
      if (!el) return null;
      return JSON.parse(el.textContent);
    } catch (e) {
      console.error('[Data] Fallback parse failed:', e);
      return null;
    }
  },

  /** Fetch data.json — let browser cache handle it, add light cache-bust */
  async fetchDataJson() {
    const url = `${CONFIG.DATA_JSON}?t=${Date.now()}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`data.json ${resp.status}`);
    return resp.json();
  },

  /** RCU live fetch removed — data synced server-side by GitHub Actions.
   *  Frontend only reads data.json (same-origin, no CORS issues). */

  /** Refresh from data.json (synced by GitHub Actions every 30 min) */
  async refresh() {
    if (state.isLoading) return;
    state.isLoading = true;

    try {
      const d = await this.fetchDataJson();
      if (d && d.players && d.results) {
        const isFallback = state.source === 'fallback';
        const oldTs = state.data ? state.data.lastUpdated : '';

        if (isFallback && d.lastUpdated === oldTs) {
          // Upgrading from slim fallback to full data.json — same timestamp,
          // just swap state.data to get matchDetails/leagueStandings without re-render
          state.data = d;
          state.source = 'data-json';
          console.log('[Data] Upgraded from fallback to data.json (silently merged matchDetails)');
        } else if (!isFallback && d.lastUpdated === oldTs && !state.firstRender) {
          console.log('[Data] data.json unchanged, skip re-render');
        } else {
          state.data = d;
          state.source = 'data-json';
          Render.all();
          UI.hideError();
          console.log('[Data] data.json loaded OK');
        }
      }
    } catch (e) {
      console.log('[Data] data.json failed:', e.message);
      if (!state.data) {
        UI.showError('数据加载失败，请稍后重试');
      }
    }

    state.isLoading = false;
  }
};

// ===== RENDER LAYER =====
const Render = {
  all() {
    if (!state.data) return;
    this.filterBar();
    this.players();
    this.results();
    this.schedule();
    this.matchDayBanner();
    this.stats();
    this.ptBar();
    this.hero();
    this.dataSource();
    // Only observe reveal elements on first render — subsequent renders skip animation
    if (state.firstRender) {
      Events.bindReveal();
      state.firstRender = false;
    }
  },

  filterBar() {
    const container = $('filterPlayer');
    if (!container || !state.data.players) return;
    // Build player filter buttons (keep "all" + add each player)
    let html = '<button class="filter-btn active" data-player="all">全部</button>';
    state.data.players.forEach(p => {
      html += `<button class="filter-btn" data-player="${Utils.escapeHtml(p.name)}">${Utils.escapeHtml(p.name)}</button>`;
    });
    container.innerHTML = html;
  },

  players() {
    const grid = $('playersGrid');
    if (!grid || !state.data.players) return;
    grid.innerHTML = state.data.players.map(p => {
      const ptCls = p.totalPt < 0 ? 'negative' : '';
      const init = p.name ? p.name.charAt(0) : '?';
      const photo = p.photo
        ? `<img src="${Utils.escapeHtml(p.photo)}" alt="${Utils.escapeHtml(p.name)}" loading="lazy" onerror="this.classList.add('img-broken')">`
        : '';
      // Donut chart for rank distribution
      const donut = Charts.donut(p.wins || 0, p.s2 || 0, p.s3 || 0, p.s4 || 0, 56);
      return `<div class="player-card${state.firstRender ? ' reveal' : ''}" data-player="${Utils.escapeHtml(p.name)}">
        <div class="player-photo" data-initial="${Utils.escapeHtml(init)}">${photo}</div>
        <h3>${Utils.escapeHtml(p.name)}</h3>
        <div class="bio">"${Utils.escapeHtml(p.bio)}"</div>
        <div class="stats-row">
          <div><div class="stat-val">${p.games}</div><div class="stat-lbl">半庄</div></div>
          <div><div class="stat-val ${ptCls}">${Utils.ptSign(p.totalPt)}${p.totalPt}</div><div class="stat-lbl">总PT</div></div>
          <div><div class="stat-val">${p.wins}</div><div class="stat-lbl">1位</div></div>
        </div>
        ${donut}
      </div>`;
    }).join('');
  },

  results() {
    const body = $('resultsBody');
    if (!body || !state.data.results) return;

    // Apply filters
    let results = state.data.results;
    if (state.filter.player !== 'all') {
      results = results.filter(r => r.player === state.filter.player);
    }
    if (state.filter.rank !== 'all') {
      results = results.filter(r => r.rank === parseInt(state.filter.rank));
    }

    // Update count
    const countEl = $('filterCount');
    if (countEl) {
      const total = state.data.results.length;
      countEl.innerHTML = `显示 <strong>${results.length}</strong> / ${total} 场`;
    }

    if (results.length === 0) {
      body.innerHTML = '<div class="filter-empty">没有符合条件的比赛记录</div>';
      this.pagination(0);
      return;
    }

    // Pagination: slice results for current page
    const totalPages = Math.ceil(results.length / state.pageSize);
    if (state.page > totalPages) state.page = 1;
    const start = (state.page - 1) * state.pageSize;
    const pageResults = results.slice(start, start + state.pageSize);

    body.innerHTML = pageResults.map(r => {
      const scoreCls = Utils.scoreClass(r.rank);
      const ptCls = Utils.ptClass(r.pt);
      return `<div class="match-row clickable" data-date="${Utils.escapeHtml(r.date)}" data-round="${Utils.escapeHtml(r.round)}" data-half="${Utils.escapeHtml(r.half)}">
        <div class="m-date"><span class="m-label">日期</span>${Utils.escapeHtml(r.date)}</div>
        <div class="m-round"><span class="m-label">轮次</span>${Utils.escapeHtml(r.round)}</div>
        <div class="m-half"><span class="m-label">半庄</span>${r.half}</div>
        <div class="m-player"><span class="m-label">选手</span>${Utils.escapeHtml(r.player)}</div>
        <div class="m-score ${scoreCls}"><span class="m-label">得点</span>${Utils.formatScore(r.score)}</div>
        <div><span class="m-label">排名</span><span class="rank-badge-sm r${r.rank}">${r.rank}位</span></div>
        <div class="m-pt ${ptCls}"><span class="m-label">PT</span>${Utils.ptSign(r.pt)}${r.pt}</div>
      </div>`;
    }).join('');

    // Render pagination controls
    this.pagination(totalPages);
  },

  pagination(totalPages) {
    const pagEl = $('resultsPagination');
    if (!pagEl) return;
    if (totalPages <= 1) {
      pagEl.innerHTML = '';
      pagEl.style.display = 'none';
      return;
    }
    pagEl.style.display = 'flex';
    let html = '';
    // Prev button
    html += `<button class="pag-btn ${state.page === 1 ? 'disabled' : ''}" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>← 上一页</button>`;
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
      html += `<button class="pag-num ${i === state.page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    // Next button
    html += `<button class="pag-btn ${state.page === totalPages ? 'disabled' : ''}" data-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''}>下一页 →</button>`;
    pagEl.innerHTML = html;
  },

  schedule() {
    const grid = $('scheduleGrid');
    if (!grid) return;

    // Filter out completed rounds (in case fallback data has stale schedule)
    const doneRounds = {};
    (state.data.results || []).forEach(r => { doneRounds[String(Utils.roundNum(r.round))] = true; });
    const upcoming = (state.data.upcoming || []).filter(s => !doneRounds[String(Utils.roundNum(s.round))]);
    state.data._filteredUpcoming = upcoming;

    if (upcoming.length === 0) {
      grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--t3);font-size:.85rem">本赛季已全部完赛</div>';
      return;
    }

    grid.innerHTML = upcoming.map(s => {
      const seen = {}, opps = [];
      (s.opponents || []).forEach(o => { if (!seen[o]) { seen[o] = 1; opps.push(o); } });
      const oppChips = opps.map(t => `<span class="op-chip">${Utils.escapeHtml(t)}</span>`).join('');
      const isToday = s.today;
      const status = isToday ? 'live' : 'up';
      const statusText = isToday ? 'TODAY' : '即将开赛';
      const link = isToday
        ? `<a href="https://space.bilibili.com/3362132" target="_blank" rel="noopener" style="color:var(--blue)">看直播 →</a>`
        : `<span style="color:var(--t3)">${Utils.escapeHtml(s.weekday || '')}</span>`;
      return `<div class="schedule-row${state.firstRender ? ' reveal' : ''}${isToday ? ' today' : ''}">
        <div class="s-date"><span class="m-label">日期</span>${Utils.escapeHtml(s.date)} · ${Utils.escapeHtml(s.time)}</div>
        <div class="s-round"><span class="m-label">轮次</span>${Utils.escapeHtml(s.round)}</div>
        <div class="s-opponents"><span class="m-label">对阵</span><span class="op-chip us">★ 花生传媒</span>${oppChips}</div>
        <div class="s-status"><span class="m-label">状态</span><span class="s-st ${status}">${statusText}</span></div>
        <div class="s-link">${link}</div>
      </div>`;
    }).join('');
  },

  matchDayBanner() {
    const banner = $('matchDayBanner');
    if (!banner || !state.data._filteredUpcoming) return;

    // Find today's match or next upcoming match
    const upcoming = state.data._filteredUpcoming;
    const todayMatch = upcoming.find(s => s.today);

    if (todayMatch) {
      banner.classList.add('show');
      const seen = {}, opps = [];
      (todayMatch.opponents || []).forEach(o => { if (!seen[o]) { seen[o] = 1; opps.push(o); } });
      $('mdTitle').textContent = '🔥 今日有比赛！';
      $('mdSub').textContent = `${todayMatch.round} · ${todayMatch.time} · 对阵 ${opps.join('、')}`;

      // Countdown to match time
      this._startCountdown(todayMatch);
    } else if (upcoming.length > 0) {
      // Show next match countdown
      const next = upcoming[0];
      banner.classList.add('show');
      const seen = {}, opps = [];
      (next.opponents || []).forEach(o => { if (!seen[o]) { seen[o] = 1; opps.push(o); } });
      $('mdTitle').textContent = '⏰ 下一场比赛';
      $('mdSub').textContent = `${next.date} · ${next.time} · ${next.round} · 对阵 ${opps.join('、')}`;
      this._startCountdown(next);
    } else {
      banner.classList.remove('show');
    }
  },

  _countdownTimer: null,
  _startCountdown(match) {
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    const cdEl = $('mdCountdown');
    const cdLabel = $('mdCdLabel');

    const update = () => {
      // Parse match date + time
      const dateStr = match.date || '';
      const timeStr = match.time || '19:00';
      // Try to extract YYYY-MM-DD from date string
      const m = dateStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (!m) {
        if (cdEl) cdEl.textContent = match.time || '';
        return;
      }
      const target = new Date(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${timeStr}:00`);
      const now = new Date();
      const diff = target - now;

      if (diff <= 0) {
        if (cdEl) cdEl.textContent = '进行中';
        if (cdLabel) cdLabel.textContent = match.today ? 'LIVE' : '状态';
        return;
      }

      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);

      if (cdLabel) cdLabel.textContent = match.today ? '距开赛' : '倒计时';
      if (days > 0) {
        if (cdEl) cdEl.textContent = `${days}天 ${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
      } else {
        if (cdEl) cdEl.textContent = `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
      }
    };

    update();
    this._countdownTimer = setInterval(update, 1000);
  },

  stats() {
    const grid = $('statsGrid');
    if (!grid || !state.data.stats) return;
    const s = state.data.stats;
    const p = s.bestPlayer || {};
    const revealCls = state.firstRender ? ' reveal' : '';
    grid.innerHTML = `
      <div class="stat-card${revealCls}"><div class="icon">🀄</div><div class="val">${s.totalGames || 0}</div><div class="lbl">已完成半庄</div></div>
      <div class="stat-card${revealCls}"><div class="icon">🏆</div><div class="val">${s.totalWins || 0}</div><div class="lbl">1位次数</div></div>
      <div class="stat-card${revealCls}"><div class="icon">📈</div><div class="val small">${Utils.ptSign(state.data.teamTotalPt)}${(state.data.teamTotalPt || 0).toFixed(1)}</div><div class="lbl">队伍总PT</div></div>
      <div class="stat-card${revealCls}"><div class="icon">⭐</div><div class="val small">${Utils.escapeHtml(p.name || '--')}</div><div class="lbl">PT王 (${Utils.ptSign(p.totalPt)}${p.totalPt || 0})</div></div>`;
  },

  ptBar() {
    const section = $('ptBarSection');
    if (!section) return;
    const pt = state.data.teamTotalPt || 0;
    const ptCls = pt >= 0 ? 'pos' : 'neg';

    // League standings for comparison
    const standings = state.data.leagueStandings || [];
    const firstPlace = standings[0] || null;
    const fourthPlace = standings[3] || null;
    const ourRank = standings.findIndex(s => s.is_ours) + 1;

    // Scale: 0 to 1st place + 15% headroom — focuses on the relevant range
    const maxPt = firstPlace ? firstPlace.totalPt * 1.15 : 300;
    const minPt = 0;
    const range = maxPt - minPt;

    // Position helper
    const ptToPct = (val) => Math.max(0, Math.min(100, ((val - minPt) / range * 100))).toFixed(1);

    const ourPct = ptToPct(pt);
    const firstPct = firstPlace ? ptToPct(firstPlace.totalPt) : null;
    const fourthPct = fourthPlace ? ptToPct(fourthPlace.totalPt) : null;

    // Target zone: shade between 4th place and 1st place
    let targetZone = '';
    if (firstPct && fourthPct) {
      const left = Math.min(firstPct, fourthPct);
      const width = Math.abs(firstPct - fourthPct);
      targetZone = `<div class="pt-bar-target-zone" style="left:${left}%;width:${width}%"></div>`;
    }

    // Markers with staggered labels (above/below) to prevent overlap
    let markers = '';
    if (firstPct) {
      markers += `<div class="pt-bar-marker first above" style="left:${firstPct}%">
        <div class="pt-bar-marker-line"></div>
        <div class="pt-bar-marker-label">#1 ${firstPlace.team}<br><span class="pt-bar-pt">${Utils.ptSign(firstPlace.totalPt)}${firstPlace.totalPt}</span></div>
      </div>`;
    }
    if (fourthPct) {
      markers += `<div class="pt-bar-marker fourth above" style="left:${fourthPct}%">
        <div class="pt-bar-marker-line"></div>
        <div class="pt-bar-marker-label">#4 ${fourthPlace.team}<br><span class="pt-bar-pt">${Utils.ptSign(fourthPlace.totalPt)}${fourthPlace.totalPt}</span></div>
      </div>`;
    }

    // Our team marker — label BELOW bar to avoid overlap with 4th place
    markers += `<div class="pt-bar-marker ours below" style="left:${ourPct}%">
      <div class="pt-bar-marker-dot"></div>
      <div class="pt-bar-marker-label">#${ourRank} 花生传媒<br><span class="pt-bar-pt">${Utils.ptSign(pt)}${pt.toFixed(1)}</span></div>
    </div>`;

    // Fill bar from 0 to our position
    const fillWidth = ourPct;

    section.innerHTML = `
      <div class="pt-bar-header">
        <div class="pt-bar-title">📊 联赛PT进度对比</div>
        <div class="pt-bar-value ${ptCls}">${Utils.ptSign(pt)}${pt.toFixed(1)}</div>
      </div>
      <div class="pt-bar-track-wide">
        <div class="pt-bar-fill-wide ${ptCls}" style="width:${fillWidth}%"></div>
        ${targetZone}
        ${markers}
      </div>
      <div class="pt-bar-labels-wide">
        <span>0</span>
        <span>${maxPt.toFixed(0)}</span>
      </div>
      <div class="pt-bar-legend">
        <div class="pt-bar-leg-item"><span class="pt-leg-dot first"></span>第1名 ${firstPlace ? firstPlace.team : ''}</div>
        <div class="pt-bar-leg-item"><span class="pt-leg-dot fourth"></span>前4名 ${fourthPlace ? fourthPlace.team : ''}</div>
        <div class="pt-bar-leg-item"><span class="pt-leg-dot ours"></span>花生传媒 (第${ourRank}名)</div>
      </div>`;
  },

  hero() {
    const d = state.data;
    const pt = $('heroTotalPT');
    if (pt) pt.textContent = (d.teamTotalPt > 0 ? '+' : '') + d.teamTotalPt;

    const hg = $('heroHalfGames');
    if (hg && d.stats) hg.textContent = d.stats.totalGames || (d.results ? d.results.length : 0);

    const cr = $('heroCompletedRounds');
    if (cr && d.stats) cr.textContent = d.stats.completedRounds || 0;

    const badge = $('heroBadge');
    if (badge && d._filteredUpcoming && d._filteredUpcoming.length) {
      const n = d._filteredUpcoming[0];
      badge.innerHTML = `<span class="dot"></span> RCU League 2026 · 下一场：${Utils.escapeHtml(n.date)}${n.today ? ' 今晚' : ''} ${Utils.escapeHtml(n.time)} · ${Utils.escapeHtml(n.round)}`;
    } else if (badge) {
      badge.innerHTML = '<span class="dot"></span> RCU League 2026 · 本赛季已完赛';
    }
  },

  dataSource() {
    const el = $('lastUpdated');
    if (!el) return;
    const labels = {
      'fallback': '📦 内置缓存',
      'data-json': '⚡ 同步数据'
    };
    const label = labels[state.source] || labels['fallback'];
    el.textContent = `${label} · ${state.data.lastUpdated || ''}`;
  }
};

// ===== UI HELPERS =====
const UI = {
  showError(msg) {
    const banner = $('errorBanner');
    const msgEl = $('errorMsg');
    if (banner) banner.classList.add('show');
    if (msgEl) msgEl.textContent = msg;
  },
  hideError() {
    const banner = $('errorBanner');
    if (banner) banner.classList.remove('show');
  }
};

// ===== MODAL =====
const Modal = {
  _keyHandler: null,

  open(name) {
    if (!state.data || !state.data.players) return;
    const p = state.data.players.find(x => x.name === name);
    if (!p) return;

    const matches = (state.data.results || []).filter(r => r.player === p.name || r.playerId === p.id);
    matches.sort((a, b) => Utils.roundNum(a.round) - Utils.roundNum(b.round));

    const avgPt = matches.length > 0 ? Utils.roundTo1(p.totalPt / matches.length) : 0;
    const winRate = matches.length > 0 ? Math.round(p.wins / matches.length * 100) : 0;
    const total = (p.wins + p.s2 + p.s3 + p.s4) || 1;

    // Rank bar
    let rbar = '';
    if (p.wins > 0) rbar += `<div class="pm-rk-gold" style="flex:${(p.wins / total * 100)}%">${p.wins}</div>`;
    if (p.s2 > 0) rbar += `<div class="pm-rk-silver" style="flex:${(p.s2 / total * 100)}%">${p.s2}</div>`;
    if (p.s3 > 0) rbar += `<div class="pm-rk-bronze" style="flex:${(p.s3 / total * 100)}%">${p.s3}</div>`;
    if (p.s4 > 0) rbar += `<div class="pm-rk-iron" style="flex:${(p.s4 / total * 100)}%">${p.s4}</div>`;

    // Header
    const init = p.name ? p.name.charAt(0) : '?';
    const photoHtml = p.photo
      ? `<img src="${Utils.escapeHtml(p.photo)}" alt="${Utils.escapeHtml(p.name)}" loading="lazy" onerror="this.classList.add('img-broken')">`
      : '';
    setHTML('pmHeader', `
      <div class="pm-photo" data-initial="${Utils.escapeHtml(init)}">${photoHtml}</div>
      <div class="pm-name">${Utils.escapeHtml(p.name)}</div>
      <div class="pm-bio">"${Utils.escapeHtml(p.bio)}"</div>
      <div class="pm-summary">
        <div class="pm-sum-item"><div class="v">${p.games}</div><div class="l">出场半庄</div></div>
        <div class="pm-sum-item"><div class="v ${p.totalPt < 0 ? 'neg' : ''}">${Utils.ptSign(p.totalPt)}${p.totalPt}</div><div class="l">累计PT</div></div>
        <div class="pm-sum-item"><div class="v">${Utils.ptSign(avgPt)}${avgPt}</div><div class="l">场均PT</div></div>
        <div class="pm-sum-item"><div class="v">${winRate}%</div><div class="l">1位率</div></div>
      </div>
      <div class="pm-rank-bar" style="margin-top:16px">${rbar}</div>
      ${Charts.donut(p.wins || 0, p.s2 || 0, p.s3 || 0, p.s4 || 0, 80)}
    `);

    // Match list
    let mhtml = matches.length ? '' : '<div class="pm-empty">暂无比赛记录</div>';
    matches.forEach(m => {
      const scCss = Utils.scoreClass(m.rank);
      mhtml += `<div class="pm-match-row">
        <div class="r-date">${Utils.escapeHtml(m.date)}</div>
        <div class="r-round">${Utils.escapeHtml(m.round)}</div>
        <div class="r-score ${scCss}">${Utils.formatScore(m.score)}</div>
        <div class="r-pt ${Utils.ptClass(m.pt)}">${Utils.ptSign(m.pt)}${m.pt}</div>
        <div class="r-rank"><span class="rank-badge-sm r${m.rank}">${m.rank}位</span></div>
      </div>`;
    });
    setHTML('pmBody', `<h4>个人比赛记录</h4><div class="pm-match-list">${mhtml}</div>`);

    // Show modal
    const overlay = $('playerModal');
    overlay.classList.add('open');

    // Bind close events (clean up previous first)
    this._cleanup();
    this._keyHandler = e => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);
    overlay.onclick = e => { if (e.target === overlay) this.close(); };
  },

  close() {
    $('playerModal').classList.remove('open');
    this._cleanup();
  },

  _cleanup() {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    const overlay = $('playerModal');
    if (overlay) overlay.onclick = null;
  }
};

// ===== MATCH MODAL (show all 4 players' scores for a half) =====
const MatchModal = {
  _keyHandler: null,

  open(date, round, half) {
    // matchDetails may not be available if only inline fallback loaded (no matchDetails)
    if (!state.data || !state.data.matchDetails) {
      setHTML('mmHeader', `<div class="mm-title">${Utils.escapeHtml(round)} · ${Utils.escapeHtml(half)}</div>`);
      setHTML('mmBody', '<div class="mm-loading">比赛详情加载中，请稍后再试...</div>');
      const overlay = $('matchModal');
      overlay.classList.add('open');
      this._cleanup();
      this._keyHandler = e => { if (e.key === 'Escape') this.close(); };
      document.addEventListener('keydown', this._keyHandler);
      overlay.onclick = e => { if (e.target === overlay) this.close(); };
      return;
    }

    // Find matching match detail
    const match = state.data.matchDetails.find(m =>
      m.date === date && m.round === round && m.half === half
    );
    if (!match) return;

    // Sort players by rank
    const players = [...match.players].sort((a, b) => a.rank - b.rank);

    // Build header
    setHTML('mmHeader', `
      <div class="mm-title">${Utils.escapeHtml(match.round)} · ${Utils.escapeHtml(match.half)}</div>
      <div class="mm-date">${Utils.escapeHtml(match.date)}</div>
    `);

    // Build player table
    const rankColors = ['gold', 'silver', 'bronze', 'iron'];
    const rankLabels = ['1位', '2位', '3位', '4位'];
    let rows = players.map((p, i) => {
      const scCls = Utils.scoreClass(p.rank);
      const ptCls = Utils.ptClass(p.pt);
      const oursCls = p.is_ours ? ' ours' : '';
      return `<div class="mm-player-row${oursCls}">
        <div class="mm-rank"><span class="rank-badge-sm r${p.rank}">${rankLabels[i]}</span></div>
        <div class="mm-team${oursCls}">${Utils.escapeHtml(p.team)}${p.is_ours ? ' ★' : ''}</div>
        <div class="mm-player-name">${Utils.escapeHtml(p.player)}</div>
        <div class="mm-score ${scCls}">${Utils.formatScore(p.score)}</div>
        <div class="mm-pt ${ptCls}">${Utils.ptSign(p.pt)}${p.pt}</div>
      </div>`;
    }).join('');

    setHTML('mmBody', `
      <div class="mm-player-thead">
        <div>排名</div><div>战队</div><div>选手</div><div>得点</div><div>PT</div>
      </div>
      <div class="mm-player-list">${rows}</div>
    `);

    // Show modal
    const overlay = $('matchModal');
    overlay.classList.add('open');

    // Bind close events
    this._cleanup();
    this._keyHandler = e => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);
    overlay.onclick = e => { if (e.target === overlay) this.close(); };
  },

  close() {
    $('matchModal').classList.remove('open');
    this._cleanup();
  },

  _cleanup() {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    const overlay = $('matchModal');
    if (overlay) overlay.onclick = null;
  }
};

// ===== EVENTS =====
const Events = {
  _revealObserver: null,

  init() {
    this.nav();
    this.modal();
    this.matchModal();
    this.pagination();
    this.retry();
    this.scroll();
    this.filter();
    this.bindReveal();
  },

  nav() {
    const navbar = $('navbar');
    const toggle = $('navToggle');
    const links = $('navLinks');

    // Scroll effect
    window.addEventListener('scroll', () => {
      navbar.classList.toggle('scrolled', window.scrollY > 60);
    }, { passive: true });

    // Mobile menu
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('open');
      links.classList.toggle('open');
    });

    // Close menu on link click
    links.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        toggle.classList.remove('open');
        links.classList.remove('open');
      });
    });

    // Active section highlight
    const sections = document.querySelectorAll('section[id]');
    const navLinks = links.querySelectorAll('a');
    window.addEventListener('scroll', () => {
      let current = '';
      sections.forEach(s => {
        if (window.scrollY >= s.offsetTop - 100) current = s.getAttribute('id');
      });
      navLinks.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + current);
      });
    }, { passive: true });

    // Smooth scroll
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) {
          e.preventDefault();
          window.scrollTo({ top: target.offsetTop - 70, behavior: 'smooth' });
        }
      });
    });
  },

  modal() {
    // Close button
    $('modalClose').addEventListener('click', () => Modal.close());

    // Player card click (event delegation)
    const grid = $('playersGrid');
    if (grid) {
      grid.addEventListener('click', e => {
        const card = e.target.closest('.player-card');
        if (!card) return;
        const name = card.getAttribute('data-player');
        if (name) Modal.open(name);
      });
    }
  },

  matchModal() {
    // Match modal close button
    const mmClose = $('matchModalClose');
    if (mmClose) mmClose.addEventListener('click', () => MatchModal.close());

    // Match row click (event delegation on results body)
    const resultsBody = $('resultsBody');
    if (resultsBody) {
      resultsBody.addEventListener('click', e => {
        const row = e.target.closest('.match-row.clickable');
        if (!row) return;
        const date = row.getAttribute('data-date');
        const round = row.getAttribute('data-round');
        const half = row.getAttribute('data-half');
        if (date && round && half) MatchModal.open(date, round, half);
      });
    }
  },

  pagination() {
    const pagEl = $('resultsPagination');
    if (pagEl) {
      pagEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-page]');
        if (!btn || btn.disabled) return;
        const page = parseInt(btn.getAttribute('data-page'));
        if (page < 1 || isNaN(page)) return;
        state.page = page;
        Render.results();
        // Scroll to results section
        const resultsSection = $('results');
        if (resultsSection) {
          window.scrollTo({ top: resultsSection.offsetTop - 70, behavior: 'smooth' });
        }
      });
    }
  },

  retry() {
    const btn = $('retryBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        UI.hideError();
        Data.refresh();
      });
    }
  },

  scroll() {
    // Already handled in nav()
  },

  filter() {
    // Player filter (event delegation)
    const playerFilter = $('filterPlayer');
    if (playerFilter) {
      playerFilter.addEventListener('click', e => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        playerFilter.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.filter.player = btn.getAttribute('data-player');
        state.page = 1; // Reset to first page on filter change
        Render.results();
      });
    }

    // Rank filter (event delegation)
    const rankFilter = $('filterRank');
    if (rankFilter) {
      rankFilter.addEventListener('click', e => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        rankFilter.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.filter.rank = btn.getAttribute('data-rank');
        state.page = 1; // Reset to first page on filter change
        Render.results();
      });
    }
  },

  bindReveal() {
    if (!this._revealObserver) {
      this._revealObserver = new IntersectionObserver(entries => {
        entries.forEach(x => {
          if (x.isIntersecting) {
            x.target.classList.add('visible');
            this._revealObserver.unobserve(x.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '50px' });
    }
    document.querySelectorAll('.reveal:not(.visible)').forEach(el => {
      this._revealObserver.observe(el);
    });

    // Safety net: force-reveal any remaining .reveal elements after 2s
    // (prevents invisible content if IntersectionObserver fails to fire)
    clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => {
      document.querySelectorAll('.reveal:not(.visible)').forEach(el => {
        el.classList.add('visible');
      });
    }, 2000);
  }
};

// ===== BOOTSTRAP =====
function init() {
  // Step 1: Render fallback data instantly (zero network)
  const fallback = Data.getFallback();
  if (fallback) {
    state.data = fallback;
    state.source = 'fallback';
    Render.all();
    console.log('[Init] Fallback data rendered');
  } else {
    console.error('[Init] No fallback data found!');
    UI.showError('内置数据加载失败，请刷新页面');
  }

  // Step 2: Bind events (wrapped in try-catch to prevent blocking data refresh)
  try {
    Events.init();
  } catch (e) {
    console.error('[Init] Events.init error:', e);
  }

  // Step 3: Try to refresh from data.json + RCU live
  Data.refresh().then(() => {
    // Step 4: Start auto-refresh timer
    state.refreshTimer = setInterval(() => Data.refresh(), CONFIG.REFRESH_MS);
    console.log(`[Init] Auto-refresh every ${CONFIG.REFRESH_MS / 60000}min`);
  }).catch(e => {
    console.error('[Init] Data.refresh error:', e);
  });
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
