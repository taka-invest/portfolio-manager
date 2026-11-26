'use strict';
// Cloud sync bookkeeping (pure logic, no Firebase): which cloud revision this PC's
// data is based on, and whether the cloud or this PC changed since then.
// Prevents the "lost update": PC-A uploading over changes PC-B saved in the meantime.

((root) => {
  const KEY = 'pm_cloud_base_v1';

  /** Key-order independent serialisation (Firestore does not preserve map key order). */
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value ?? null);
  }

  /** Change-detection fingerprint (not a security hash): two FNV-1a 32-bit lanes. */
  function hash(value) {
    const text = canonical(value);
    let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x0100019d) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  function readAll(storage) {
    try {
      const v = JSON.parse(storage.getItem(KEY));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }

  /** The cloud revision this PC last uploaded or imported, per Google account. */
  function readBase(storage, uid) {
    const b = readAll(storage)[uid];
    return b && Number.isSafeInteger(b.revision) && b.revision >= 0 && typeof b.hash === 'string' ? b : null;
  }

  function writeBase(storage, uid, revision, payload, now = Date.now()) {
    const all = readAll(storage);
    all[uid] = { revision, hash: hash(payload), at: new Date(now).toISOString() };
    storage.setItem(KEY, JSON.stringify(all));
    return all[uid];
  }

  /**
   * Relation between this PC and the cloud.
   *   empty    – nothing in the cloud yet
   *   unknown  – this PC has no sync record (first use, or synced before this version)
   *   synced   – cloud unchanged since this PC's base, and no local edits
   *   ahead    – only this PC changed since the base (safe to upload)
   *   behind   – only the cloud changed (another PC saved); upload would revert it
   *   conflict – both changed; upload would discard the other PC's changes
   *   mismatch – cloud revision is older than this PC's record (restored / other account data)
   */
  function relation({ base, remoteRevision, local }) {
    if (!remoteRevision) return { kind: base && base.revision > 0 ? 'mismatch' : 'empty', localChanged: true };
    if (!base) return { kind: 'unknown', localChanged: null };
    const localChanged = hash(local) !== base.hash;
    if (remoteRevision < base.revision) return { kind: 'mismatch', localChanged };
    if (remoteRevision === base.revision) return { kind: localChanged ? 'ahead' : 'synced', localChanged };
    return { kind: localChanged ? 'conflict' : 'behind', localChanged };
  }

  function describe(rel, base, remoteRevision) {
    const from = base ? base.revision : '?';
    switch (rel.kind) {
      case 'empty': return { text: 'クラウドは空です。', warn: false };
      case 'unknown': return { text: 'このPCの同期記録がありません（保存・取り込みを1回行うと記録されます）。', warn: false };
      case 'synced': return { text: '同期済み：このPCはクラウドの最新リビジョンと同じ内容です。', warn: false };
      case 'ahead': return { text: 'このPCにクラウド未保存の変更があります。', warn: false };
      case 'behind': return { text: `別端末でクラウドが更新されています（リビジョン ${from} → ${remoteRevision}）。「クラウド → このPC」で取り込んでください。`, warn: true };
      case 'conflict': return { text: `このPCとクラウドの両方が変更されています（クラウド リビジョン ${from} → ${remoteRevision}）。保存すると別端末の変更が失われます。`, warn: true };
      case 'mismatch': return { text: `クラウドのリビジョン（${remoteRevision}）がこのPCの記録（${from}）より古くなっています。内容を確認してください。`, warn: true };
      default: return { text: '', warn: false };
    }
  }

  const api = { KEY, canonical, hash, readBase, writeBase, relation, describe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMCloudSync = api;
})(globalThis);
