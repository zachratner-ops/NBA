/* gyou.in shared behaviors: site menu + shared helpers.
   Load with <script src="site.js" defer></script> after the sitebar markup. */

(function () {
  const NAV = [
    { href: 'index.html', label: 'Home', icon: '🏠' },
    { group: 'Active' },
    { href: 'wc-draft.html', label: 'World Cup 2026', icon: '⚽' },
    { href: 'bets.html', label: 'One-Off Bets', icon: '🤝' },
    { href: 'bernie.html', label: 'The Bernie Bet', icon: '☠️' },
    { group: 'History' },
    { href: 'nba-playoffs-2026.html', label: 'Playoff Points 2026', icon: '🏀' },
    { href: 'nba-history.html', label: 'NBA Playoff History', icon: '🏀' },
    { href: 'golf-live.html', label: 'Golf Live', icon: '⛳' },
    { href: 'golf.html', label: 'Golf Major History', icon: '⛳' },
    { group: 'Side Quests' },
    { href: 'dunlap.html', label: 'Dunlap 2026', icon: '🦌' },
  ];

  function init() {
    const bar = document.querySelector('.sitebar');
    if (!bar) return;
    const actions = bar.querySelector('.sb-actions');
    if (!actions) return;

    const here = (location.pathname.split('/').pop() || 'index.html');

    const btn = document.createElement('button');
    btn.className = 'sb-btn';
    btn.setAttribute('aria-label', 'Site menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '☰';

    const menu = document.createElement('nav');
    menu.className = 'sb-menu';
    menu.setAttribute('aria-label', 'All bets');
    menu.innerHTML = NAV.map(item => item.group
      ? `<div class="sb-group">${item.group}</div>`
      : `<a href="${item.href}"${item.href === here ? ' class="current"' : ''}><span>${item.icon}</span>${item.label}</a>`
    ).join('');

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
