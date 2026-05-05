/**
 * lib/backup_remote.js — 加密備份上傳到 GitHub Releases
 *
 * runBackupAndUpload()  — 產生 .db 快照 → AES-256-GCM 加密 → 上傳 GitHub Release
 * 保留最近 30 個 release，超過自動刪舊
 *
 * 需要環境變數：
 *   GITHUB_TOKEN   — GitHub PAT（repo 權限）
 *   GITHUB_OWNER   — 例如 xup6124919766-maker
 *   GITHUB_REPO    — 例如 cs-center
 *   ENCRYPTION_KEY — 64 char hex（與 lib/crypto.js 共用）
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runBackup } from './backup.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'backup_remote' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KEEP_RELEASES = 30;

// ─── 加密（AES-256-GCM）───
const encryptFile = (srcPath, destPath) => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const input = fs.readFileSync(srcPath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  // 格式：iv(16) + authTag(16) + ciphertext
  const output = Buffer.concat([iv, authTag, encrypted]);
  fs.writeFileSync(destPath, output);

  log.info({ src: path.basename(srcPath), dest: path.basename(destPath), size_kb: Math.round(output.length / 1024) }, 'file encrypted');
  return destPath;
};

// ─── GitHub API helpers ───
const ghHeaders = () => ({
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'cs-center-backup/1.0',
});

const ghBase = () => {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!owner || !repo) throw new Error('GITHUB_OWNER / GITHUB_REPO env vars missing');
  return `https://api.github.com/repos/${owner}/${repo}`;
};

// 建立 Release
const createRelease = async (tagName, name, body = '') => {
  const r = await fetch(`${ghBase()}/releases`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ tag_name: tagName, name, body, draft: false, prerelease: false }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`createRelease failed ${r.status}: ${err}`);
  }
  return r.json();
};

// 上傳 asset 到 Release
const uploadAsset = async (uploadUrl, assetPath, assetName) => {
  // uploadUrl 格式: "https://uploads.github.com/repos/.../releases/xxx/assets{?name,label}"
  const url = uploadUrl.replace('{?name,label}', '') + `?name=${encodeURIComponent(assetName)}`;

  const data = fs.readFileSync(assetPath);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      ...ghHeaders(),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
    },
    body: data,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`uploadAsset failed ${r.status}: ${err}`);
  }
  return r.json();
};

// 列出 Releases（標籤 backup- 開頭）
const listBackupReleases = async () => {
  const r = await fetch(`${ghBase()}/releases?per_page=100`, {
    headers: ghHeaders(),
  });
  if (!r.ok) throw new Error(`listReleases failed ${r.status}`);
  const all = await r.json();
  return all.filter(rel => rel.tag_name.startsWith('backup-'));
};

// 刪除 Release（含 tag）
const deleteRelease = async (releaseId, tagName) => {
  // 先刪 release
  await fetch(`${ghBase()}/releases/${releaseId}`, {
    method: 'DELETE',
    headers: ghHeaders(),
  });
  // 再刪 tag
  await fetch(`${ghBase()}/git/refs/tags/${tagName}`, {
    method: 'DELETE',
    headers: ghHeaders(),
  });
  log.info({ releaseId, tagName }, 'old backup release deleted');
};

// ─── 清理舊 Releases（保留最新 KEEP_RELEASES 個）───
const pruneOldReleases = async () => {
  try {
    const releases = await listBackupReleases();
    // 依 created_at 降序（最新在前）
    releases.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const toDelete = releases.slice(KEEP_RELEASES);
    for (const rel of toDelete) {
      await deleteRelease(rel.id, rel.tag_name);
    }
    if (toDelete.length > 0) {
      log.info({ deleted_count: toDelete.length }, 'old releases pruned');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'pruneOldReleases failed (non-fatal)');
  }
};

// ─── 主函式 ───
export const runBackupAndUpload = async () => {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set');

  // 1. 本地備份
  const backupResult = runBackup();
  if (!backupResult.ok) throw new Error(`Local backup failed: ${backupResult.error}`);

  const { dest: dbPath, ts } = backupResult;
  const encPath = dbPath + '.enc';

  try {
    // 2. 加密
    encryptFile(dbPath, encPath);

    // 3. 建立 GitHub Release
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const tagName = `backup-${today}`;
    const assetName = `cs-${ts}.db.enc`;

    log.info({ tagName, assetName }, 'creating GitHub release');
    const release = await createRelease(
      tagName,
      `Backup ${today}`,
      `Encrypted SQLite backup — ${ts} UTC\nDecrypt with AES-256-GCM using ENCRYPTION_KEY.`,
    );

    // 4. 上傳加密檔
    await uploadAsset(release.upload_url, encPath, assetName);
    log.info({ tagName, assetName, release_id: release.id }, 'backup uploaded to GitHub');

    // 5. 清理舊 releases
    await pruneOldReleases();

    return { ok: true, tagName, assetName, release_url: release.html_url };
  } finally {
    // 清理本地暫存加密檔
    try { fs.unlinkSync(encPath); } catch {}
  }
};

// ─── 排程：每小時檢查，UTC 03:00 執行 ───
export const scheduleRemoteBackup = () => {
  setInterval(() => {
    const now = new Date();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    if (h === 3 && m === 0) {
      log.info('scheduled remote backup triggered at UTC 03:00');
      runBackupAndUpload().catch(e => log.error({ err: e.message }, 'remote backup failed'));
    }
  }, 60 * 60 * 1000).unref();
  log.info('remote backup scheduler started (runs daily at UTC 03:00)');
};
