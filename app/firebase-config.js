// Firebase web configuration is PUBLIC project metadata, not a secret.
// Source: `firebase apps:sdkconfig WEB` for "Finance Base Web" (finance-base-edcc7), 2026-11-23.
// Access to data is enforced by Firestore Security Rules + the UID allowlist, not by this key.
// Do not place OAuth secrets, private keys, service accounts, or API tokens here.
window.PMFirebaseWebConfig = {
  apiKey: 'AIzaSyDZmiejVY_sPGE19B4V7Rbp8lWauNXVowA',
  authDomain: 'finance-base-edcc7.firebaseapp.com',
  projectId: 'finance-base-edcc7',
  storageBucket: 'finance-base-edcc7.firebasestorage.app',
  messagingSenderId: '472264087274',
  appId: '1:472264087274:web:af5ac46e3e19c34f466993'
};

// Resolved by app/firebase-cloud.mjs once Auth is initialised (or unavailable), so
// API calls made during page load can wait for the restored sign-in.
window.PMCloudReady = window.PMCloudReady || new Promise(resolve => { window.__pmCloudResolve = resolve; });
