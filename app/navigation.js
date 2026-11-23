'use strict';
((root) => {
  const groups = {
    overview: ['overview'],
    holdings: ['holdings'],
    rebalance: ['allocation', 'rebalance', 'after'],
    market: ['market'],
    companies: ['companies'],
    research: ['research'],
    history: ['history']
  };
  const titles = {
    overview: 'ダッシュボード',
    holdings: '保有資産',
    rebalance: 'リバランス',
    market: '市場分析',
    companies: '企業評価',
    research: '投資リサーチ',
    history: '取引・購入計画'
  };
  const hashToPage = Object.fromEntries(
    Object.entries(groups).flatMap(([page, ids]) => ids.map(id => [id, page]))
  );
  hashToPage['data-settings'] = 'overview';
  const byId = id => document.getElementById(id);

  function init() {
    const frame = byId('pm-app-frame');
    const sidebar = byId('pm-side-nav');
    const backdrop = byId('pm-nav-scrim');
    const mobileToggle = byId('pm-nav-open');
    const mobileClose = byId('pm-nav-close');
    const collapseToggle = byId('pm-nav-collapse');
    const subnav = byId('pm-rebalance-subnav');
    const mobile = root.matchMedia('(max-width: 900px)');
    const links = Array.from(sidebar.querySelectorAll('a[data-pm-view]'));
    let open = false;
    let preferCollapsed = false;
    try { preferCollapsed = localStorage.getItem('pm_sidebar_collapsed_v1') === 'true'; }
    catch { /* optional display preference */ }

    function collapse(value) {
      frame.classList.toggle('pm-nav-collapsed', value);
      collapseToggle.setAttribute('aria-expanded', String(!value));
      const label = value ? 'サイドバーを展開' : 'サイドバーを折りたたむ';
      collapseToggle.setAttribute('aria-label', label);
      collapseToggle.title = label;
      collapseToggle.querySelector('.pm-nav-label').textContent = value ? '展開' : '折りたたむ';
      collapseToggle.querySelector('.pm-nav-symbol').textContent = value ? '»' : '«';
    }
    function drawer(value, restoreFocus = false) {
      open = value && mobile.matches;
      frame.classList.toggle('pm-nav-open', open);
      document.body.classList.toggle('pm-nav-mobile-open', open);
      backdrop.hidden = !open;
      sidebar.inert = mobile.matches && !open;
      mobileToggle.setAttribute('aria-expanded', String(open));
      if (open) sidebar.querySelector('a[data-pm-view]')?.focus({ preventScroll: true });
      else if (restoreFocus && mobile.matches) mobileToggle.focus({ preventScroll: true });
    }

    function route(initial = false) {
      const hash = decodeURIComponent(root.location.hash.slice(1)) || 'overview';
      const page = hashToPage[hash] || 'overview';
      for (const [name, sections] of Object.entries(groups)) {
        for (const id of sections) byId(id).hidden = name !== page;
      }
      subnav.hidden = page !== 'rebalance';
      byId('pm-current-page').textContent = titles[page];
      for (const link of links) {
        const active = hash === 'data-settings'
          ? link.getAttribute('href') === '#data-settings'
          : link.dataset.pmView === page && link.getAttribute('href') !== '#data-settings';
        link.classList.toggle('pm-nav-active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      const settings = byId('data-settings');
      if (hash === 'data-settings' && settings?.tagName === 'DETAILS') settings.open = true;
      drawer(false);
      if (!initial || root.location.hash) {
        const section = hashToPage[hash] ? byId(hash) : byId('overview');
        root.requestAnimationFrame(() => {
          section.scrollIntoView({ block: 'start', behavior: 'auto' });
          const heading = section.matches('section')
            ? section.querySelector('h1, h2')
            : section.querySelector('summary, h2');
          if (heading) {
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }
        });
      }
    }

    collapse(preferCollapsed);
    drawer(false);
    collapseToggle.addEventListener('click', () => {
      const value = !frame.classList.contains('pm-nav-collapsed');
      collapse(value);
      try { localStorage.setItem('pm_sidebar_collapsed_v1', String(value)); }
      catch { /* optional display preference */ }
    });
    mobileToggle.addEventListener('click', () => drawer(true));
    mobileClose.addEventListener('click', () => drawer(false, true));
    backdrop.addEventListener('click', () => drawer(false, true));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && open) drawer(false, true);
    });
    mobile.addEventListener('change', () => drawer(false));
    sidebar.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', () => {
        if (root.location.hash === link.getAttribute('href')) route();
        drawer(false);
      });
    });
    subnav.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', () => {
        if (root.location.hash === link.getAttribute('href')) route();
      });
    });
    root.addEventListener('hashchange', () => route());
    route(true);
  }
  root.PMNavigation = { init };
})(globalThis);
