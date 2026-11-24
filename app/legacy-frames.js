'use strict';
// Load the embedded legacy Stock Analyzer pages only when their route is opened
// (keeps the dashboard fast and avoids Tailwind/CDN work until needed).
((root) => {
  function load() {
    const id = decodeURIComponent(root.location.hash.slice(1));
    const section = id && document.getElementById(id);   // empty hash or unknown id: nothing to load
    const frame = section && section.querySelector('iframe.pm-legacy-frame');
    if (frame && !frame.src) frame.src = frame.dataset.src;
  }
  root.addEventListener('hashchange', load);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
  root.PMLegacyFrames = { load };
})(globalThis);
