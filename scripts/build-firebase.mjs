// Explicit allow-list: never publish tests, GitHub workflows, credentials, or functions.
import { cpSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist', 'firebase');
const files = ['portfolio_manager.html'];
const dirs = ['app', 'research'];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of files) copyFileSync(join(root, file), join(out, file));
for (const dir of dirs) {
  if (!existsSync(join(root, dir))) throw new Error('Missing source folder: ' + dir);
  cpSync(join(root, dir), join(out, dir), { recursive: true });
}
const forbidden = ['.git', '.github', 'tests', 'docs', 'functions', 'node_modules', 'firebase.json', 'firestore.rules'];
for (const p of forbidden) if (existsSync(join(out, p))) throw new Error('Private directory leaked: ' + p);
console.log('Firebase static bundle prepared:', out);
