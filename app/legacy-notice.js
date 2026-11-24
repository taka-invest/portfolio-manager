'use strict';
// Phase 8 migration notice: when this app is opened from the OLD GitHub Pages URL,
// tell the user where the official app lives and how to carry their data over.
// Never redirects automatically: the old origin's browser storage holds data that
// must be exported (JSON) before leaving.
((root) => {
  const NEW_URL = 'https://finance-base-edcc7.web.app/';
  const LEGACY_HOSTS = ['taka-invest.github.io'];

  function isLegacyHost(hostname) {
    return LEGACY_HOSTS.includes(String(hostname || '').toLowerCase());
  }

  function show() {
    if (!isLegacyHost(root.location.hostname)) return false;
    const bar = document.createElement('div');
    bar.id = 'pm-legacy-notice';
    bar.setAttribute('role', 'alert');
    bar.className = 'pm-callout';
    bar.dataset.warn = 'true';
    bar.style.cssText = 'margin:12px;position:relative;z-index:50;background:var(--bg2)';
    bar.innerHTML = '<strong>このURLは旧版です（近日停止予定）。</strong> 正式なアプリは '
      + '<a href="' + NEW_URL + '" rel="noopener">' + NEW_URL + '</a> に移行しました。'
      + '<br>このブラウザーに保存した保有データは新URLへ自動では移りません。'
      + '「設定・データ管理」→「JSONを書き出す」でバックアップし、新URLで「JSONを選択」から取り込むか、'
      + '新URLでGoogleログインして「クラウド → このPC」で復元してください。';
    document.body.prepend(bar);
    return true;
  }

  root.PMLegacyNotice = { isLegacyHost, show, NEW_URL };
  if (typeof module === 'object' && module.exports) module.exports = root.PMLegacyNotice;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})(globalThis);
