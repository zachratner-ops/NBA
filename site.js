/* gyou.in shared behaviors: site menu + shared helpers.
   Load with <script src="site.js" defer></script> after the sitebar markup.

   The Active section of the menu mirrors the homepage: it reads the same
   Firebase site_config the commissioner panel writes, so activating a
   card on the home page adds its link here automatically. */

(function () {
  const FIREBASE_BASE = 'https://giesener-bets-default-rtdb.firebaseio.com';

  /* Menu metadata per homepage card id (index.html CARDS). Cards without
     a page yet are simply absent — add an entry when the page exists. */
  const MENU_CARDS = {
    'wc2026': { href: 'wc-draft.html?slug=wc2026', label: 'World Cup 2026', icon: '⚽' },
    'oneoff-bets': { href: 'bets.html', label: 'One-Off Bets', icon: '🤝' },
    'bernie-bet': { href: 'bernie.html', label: 'The Bernie Bet', icon: '☠️' },
    'dunlap-2026': { href: 'dunlap.html', label: "Matt's 2026 Goals", icon: '🦌' },
    'open-26': { href: 'golf-live.html?slug=open-26', label: '2026 Open Championship', icon: '⛳' },
  };
  const HISTORY = [
    { href: 'nba-history.html', label: 'NBA Playoff History', icon: '🏀' },
    { href: 'golf.html', label: 'Golf Major History', icon: '⛳' },
  ];
  /* Same fallback the homepage uses when Firebase is unreachable. */
  const DEFAULT_ACTIVE = ['wc2026', 'oneoff-bets', 'bernie-bet'];

  let menu = null;

  function itemHtml(item, here) {
    const current = item.href.split('?')[0] === here ? ' class="current"' : '';
    return `<a href="${item.href}"${current}><span>${item.icon}</span>${item.label}</a>`;
  }

  function setMenu(activeIds) {
    if (!menu) return;
    const here = (location.pathname.split('/').pop() || 'index.html');
    const active = activeIds.filter(id => MENU_CARDS[id]).map(id => MENU_CARDS[id]);
    menu.innerHTML = [
      itemHtml({ href: 'index.html', label: 'Home', icon: '🏠' }, here),
      active.length ? '<div class="sb-group">Active</div>' : '',
      ...active.map(i => itemHtml(i, here)),
      '<div class="sb-group">History</div>',
      ...HISTORY.map(i => itemHtml(i, here)),
    ].join('');
  }

  function loadActiveCards() {
    fetch(`${FIREBASE_BASE}/site_config.json`)
      .then(r => r.json())
      .then(cfg => {
        cfg = cfg || {};
        const states = cfg.cards || {};
        DEFAULT_ACTIVE.forEach(id => { if (!(id in states)) states[id] = true; });
        const order = Array.isArray(cfg.cardOrder) ? cfg.cardOrder : [];
        const ids = Object.keys(MENU_CARDS)
          .filter(id => states[id] === true)
          .sort((a, b) => ((order.indexOf(a) + 1) || 999) - ((order.indexOf(b) + 1) || 999));
        setMenu(ids);
      })
      .catch(() => {});
  }

  function init() {
    const bar = document.querySelector('.sitebar');
    if (!bar) return;
    const actions = bar.querySelector('.sb-actions');
    if (!actions) return;

    const btn = document.createElement('button');
    btn.className = 'sb-btn';
    btn.setAttribute('aria-label', 'Site menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '☰';

    menu = document.createElement('nav');
    menu.className = 'sb-menu';
    menu.setAttribute('aria-label', 'All bets');
    setMenu(DEFAULT_ACTIVE);
    loadActiveCards();

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    actions.appendChild(btn);
    bar.appendChild(menu);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* Shared helpers — adopt in pages as they get touched. */
  window.GAYI = window.GAYI || {};
  window.GAYI.fmtMoney = function (n) {
    return n === 0 ? '$0' : (n > 0 ? '+$' : '-$') + Math.abs(n).toLocaleString();
  };
})();
