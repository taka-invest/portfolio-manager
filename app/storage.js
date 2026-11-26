'use strict';

((root) => {
  const data = root.PMData;

  function read(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  function legacyPreferences() {
    const preferences = {};
    for (const key of ['theme', 'currency', 'perf_start']) {
      const value = localStorage.getItem('pm_' + key);
      if (value) preferences[key] = value;
    }
    const acc = read('pm_ac', {});
    preferences.ac = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v === 'closed']));
    for (const key of ['l1_trigger', 'l2_harvest', 'cash_min']) {
      const value = localStorage.getItem('pm_' + key);
      if (value != null && value.trim() && Number.isFinite(Number(value))) preferences[key] = Number(value);
    }
    return preferences;
  }


  let lastRaw = null;
  function load() {
    lastRaw = localStorage.getItem(data.KEY);
    return lastRaw ? data.validate(JSON.parse(lastRaw)) : { ...data.blank(), preferences: legacyPreferences() };
  }

  function save(next, backup = false, recovering = false) {
    const value = data.validate(next);
    if (lastRaw !== localStorage.getItem(data.KEY)) throw new Error('別タブで保存が変更されました。再読み込みしてください。');
    const raw = JSON.stringify(value);
    if (recovering && lastRaw) localStorage.setItem(data.KEY + '_invalid', lastRaw);
    else if (backup && lastRaw) localStorage.setItem(data.BACKUP, lastRaw);
    localStorage.setItem(data.KEY, raw);
    lastRaw = raw;
    return value;
  }

  async function readFile(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error('JSONファイルは10 MBまで読み込めます。');
    try { return JSON.parse(await file.text()); }
    catch { throw new Error('JSONファイルを読み込めません。'); }
  }



  root.PMStorage = { read, legacyPreferences, load, save, readFile };
})(globalThis);
