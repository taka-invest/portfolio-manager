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

  function legacyData() {
    const legacy = { preferences: legacyPreferences() };
    for (const [field, key] of Object.entries({
      positions: 'pm_positions', plans: 'pm_plans', trades: 'pm_trade_log', watchlist: 'pm_watchlist'
    })) {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        try { legacy[field] = JSON.parse(raw); }
        catch { throw new Error('旧ブラウザー保存のJSONを読み込めません。元データは保持されています。'); }
      }
    }
    return legacy;
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

  async function legacyFile() {
    const handle = await new Promise((resolve, reject) => {
      const open = indexedDB.open('pm_fs');
      open.onerror = () => reject(new Error('旧保存先を読み込めません。'));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('handles')) { db.close(); resolve(null); return; }
        const tx = db.transaction('handles');
        const get = tx.objectStore('handles').get('fileHandle');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(new Error('旧保存先を読み込めません。'));
        tx.oncomplete = () => db.close();
      };
    });
    if (!handle) throw new Error('旧保存先がありません。JSONファイルを選択してください。');
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') {
      const permission = await handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
      if (permission !== 'granted') throw new Error('旧保存先のJSONファイルを直接選択してください。');
    }
    return readFile(await handle.getFile());
  }

  async function jsonbin(key, id, snapshot) {
    if (!key || (snapshot === undefined && !/^[a-f\d]{24}$/i.test(id))) throw new Error('JSONBinのキーとBin IDを確認してください。');
    const endpoint = 'https://api.jsonbin.io/v3/b';
    const headers = { 'X-Master-Key': key };
    let response;
    try {
      response = snapshot === undefined
        ? await fetch(endpoint + '/' + id + '/latest', { headers, signal: AbortSignal.timeout(15000) })
        : await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { ...headers, 'Content-Type': 'application/json', 'X-Bin-Name': 'portfolio-manager', 'X-Bin-Private': 'true' },
          body: JSON.stringify(snapshot) });
    } catch { throw new Error('JSONBinに接続できません。'); }
    if (!response.ok) throw new Error('JSONBinからエラーが返りました（HTTP ' + response.status + '）。');
    const result = await response.json();
    if (snapshot === undefined) return result.record;
    if (!/^[a-f\d]{24}$/i.test(result.metadata?.id)) throw new Error('JSONBinの作成結果を確認してください。');
    return result.metadata.id;
  }

  root.PMStorage = { read, legacyData, legacyPreferences, load, save, readFile, legacyFile, jsonbin };
})(globalThis);
