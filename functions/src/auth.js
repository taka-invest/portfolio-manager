// Shared access gate for every private finance API.
// A caller must present a valid, non-revoked Firebase ID token issued for a
// Google sign-in AND their UID must be enabled in Firestore /allowlist/{uid}
// (the same list the Firestore Security Rules use).
const CACHE_MS = 60_000;
const cache = new Map(); // uid -> { allowed, expires }

export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function bearer(header, emulator = process.env.FUNCTIONS_EMULATOR === 'true') {
  const value = String(header || '');
  // Production tokens are always signed. The Auth Emulator issues unsigned tokens
  // ("header.payload."), accepted ONLY when running inside the Functions Emulator.
  const shape = emulator ? /^Bearer [\w-]+\.[\w-]+\.[\w-]*$/ : /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/;
  if (!shape.test(value)) throw new AccessError(401, 'Google login required');
  return value.slice(7);
}

export async function authorize(header, { verifyIdToken, isAllowed, now = Date.now }) {
  const raw = bearer(header);
  let token;
  try { token = await verifyIdToken(raw, true); }
  catch { throw new AccessError(401, 'Authentication failed'); }
  if (token.firebase?.sign_in_provider !== 'google.com') throw new AccessError(403, 'Google sign-in required');
  const hit = cache.get(token.uid);
  let ok;
  if (hit && hit.expires > now()) ok = hit.allowed;
  else {
    ok = (await isAllowed(token.uid)) === true;
    cache.set(token.uid, { allowed: ok, expires: now() + CACHE_MS });
  }
  if (!ok) throw new AccessError(403, 'This account is not authorized');
  return token.uid;
}

export function clearAuthCacheForTest() { cache.clear(); }
