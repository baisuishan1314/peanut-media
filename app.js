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
  isLoading: false
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

  /** Fetch data.json with cache-busting */
  async fetchDataJson() {
    const url = `${CONFIG.DATA_JSON}?t=${Date.now()}`;
    const resp = await fetch(url, { cache: 'no-store' });
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
        state.data = d;
        state.source = 'data-json';
        Render.all();
        UI.hideError();
        console.log('[Data] data.json loaded OK');
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
    this.players();
    this.results();
    this.schedule();
    this.stats();
    this.hero();
    this.dataSource();
    // Re-observe new reveal elements
    Events.bindReveal();
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
      const chips = [
        ...Array(p.wins || 0).fill('<div class="rank-chip win">1</div>'),
        ...Array(p.s2 || 0).fill('<div class="rank-chip s2">2</div>'),
        ...Array(p.s3 || 0).fill('<div class="rank-chip s3">3</div>'),
        ...Array(p.s4 || 0).fill('<div class="rank-chip s4">4</div>')
      ].join('');
      return `<div class="player-card reveal" data-player="${Utils.escapeHtml(p.name)}">
        <div class="player-photo" data-initial="${Utils.escapeHtml(init)}">${photo}</div>
        <h3>${Utils.escapeHtml(p.name)}</h3>
        <div class="bio">"${Utils.escapeHtml(p.bio)}"</div>
        <div class="stats-row">
          <div><div class="stat-val">${p.games}</div><div class="stat-lbl">半庄</div></div>
          <div><div class="stat-val ${ptCls}">${Utils.ptSign(p.totalPt)}${p.totalPt}</div><div class="stat-lbl">总PT</div></div>
          <div><div class="stat-val">${p.wins}</div><div class="stat-lbl">1位</div></div>
        </div>
        <div class="rank-dist">${chips}</div>
      </div>`;
    }).join('');
  },

  results() {
    const body = $('resultsBody');
    if (!body || !state.data.results) return;
    body.innerHTML = state.data.results.map(r => {
      const scoreCls = Utils.scoreClass(r.rank);
      const ptCls = Utils.ptClass(r.pt);
      return `<div class="match-row reveal">
        <div class="m-date"><span class="m-label">日期</span>${Utils.escapeHtml(r.date)}</div>
        <div class="m-round"><span class="m-label">轮次</span>${Utils.escapeHtml(r.round)}</div>
        <div class="m-half"><span class="m-label">半庄</span>${r.half}</div>
        <div class="m-player"><span class="m-label">选手</span>${Utils.escapeHtml(r.player)}</div>
        <div class="m-score ${scoreCls}"><span class="m-label">得点</span>${Utils.formatScore(r.score)}</div>
        <div><span class="m-label">排名</span><span class="rank-badge-sm r${r.rank}">${r.rank}位</span></div>
        <div class="m-pt ${ptCls}"><span class="m-label">PT</span>${Utils.ptSign(r.pt)}${r.pt}</div>
      </div>`;
    }).join('');
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
      const status = s.today ? 'live' : 'up';
      const statusText = s.today ? 'TODAY' : '即将开赛';
      const link = s.today
        ? `<a href="https://space.bilibili.com/3362132" target="_blank" rel="noopener" style="color:var(--blue)">看直播 →</a>`
        : `<span style="color:var(--t3)">${Utils.escapeHtml(s.weekday || '')}</span>`;
      return `<div class="schedule-row reveal${s.today ? ' today' : ''}">
        <div class="s-date"><span class="m-label">日期</span>${Utils.escapeHtml(s.date)} · ${Utils.escapeHtml(s.time)}</div>
        <div class="s-round"><span class="m-label">轮次</span>${Utils.escapeHtml(s.round)}</div>
        <div class="s-opponents"><span class="m-label">对阵</span><span class="op-chip us">★ 花生传媒</span>${oppChips}</div>
        <div class="s-status"><span class="m-label">状态</span><span class="s-st ${status}">${statusText}</span></div>
        <div class="s-link">${link}</div>
      </div>`;
    }).join('');
  },

  stats() {
    const grid = $('statsGrid');
    if (!grid || !state.data.stats) return;
    const s = state.data.stats;
    const p = s.bestPlayer || {};
    grid.innerHTML = `
      <div class="stat-card reveal"><div class="icon">🀄</div><div class="val">${s.totalGames || 0}</div><div class="lbl">已完成半庄</div></div>
      <div class="stat-card reveal"><div class="icon">🏆</div><div class="val">${s.totalWins || 0}</div><div class="lbl">1位次数</div></div>
      <div class="stat-card reveal"><div class="icon">📈</div><div class="val small">${Utils.ptSign(state.data.teamTotalPt)}${(state.data.teamTotalPt || 0).toFixed(1)}</div><div class="lbl">队伍总PT</div></div>
      <div class="stat-card reveal"><div class="icon">⭐</div><div class="val small">${Utils.escapeHtml(p.name || '--')}</div><div class="lbl">PT王 (${Utils.ptSign(p.totalPt)}${p.totalPt || 0})</div></div>`;
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

// ===== EVENTS =====
const Events = {
  _revealObserver: null,

  init() {
    this.nav();
    this.modal();
    this.retry();
    this.scroll();
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
