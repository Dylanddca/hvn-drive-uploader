require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// Files are held in memory just long enough to stream them to Drive, then
// discarded — nothing is ever written to disk on this server. 300MB per
// file is plenty for photos/audio/most video clips; raise it if a model's
// video files are routinely bigger than that.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

const PARENT_FOLDER_ID = process.env.DRIVE_PARENT_FOLDER_ID; // the "root" Drive folder everything gets created inside
const ADMIN_API_KEY = process.env.PROXY_API_KEY; // required for admin-only actions (creating folders)

// ── Google Drive client (service account) ──────────────────────────────────
function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Admin-only actions (creating folders from the HVN Hub app) need this key
// so a random person can't spam-create folders in your Drive. Uploading and
// listing files does NOT require it — those are reached via the model's
// share link, which has no login, so the folder ID itself is what limits
// who can use it (same idea as the share_token links elsewhere in the app).
function requireAdminKey(req, res, next) {
  if (!ADMIN_API_KEY || req.headers['x-api-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('HVN Drive Proxy is running.'));

// ── Create a folder for a model's script ────────────────────────────────
// Called once when an admin creates a script for a model in Sexting Scripts.
// body: { name: "Coco - 2026-07-18" }
app.post('/folders', requireAdminKey, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const drive = getDriveClient();
    const folder = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: PARENT_FOLDER_ID ? [PARENT_FOLDER_ID] : undefined,
      },
      fields: 'id, webViewLink',
    });
    // Anyone with the link can view/add — good enough since the link itself
    // isn't public anywhere, only shared directly with the model.
    await drive.permissions.create({
      fileId: folder.data.id,
      requestBody: { role: 'writer', type: 'anyone' },
    }).catch(() => {});
    res.json({ folderId: folder.data.id, folderUrl: folder.data.webViewLink });
  } catch (e) {
    console.error('[folders] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Upload a file into a folder ─────────────────────────────────────────
// This is what the model's drag-and-drop hits directly (no login/API key —
// the folder ID is the only thing you need, same trust model as the share
// links used elsewhere in the app).
app.post('/folders/:folderId/upload', upload.single('file'), async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const drive = getDriveClient();
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);
    const uploaded = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: req.file.mimetype || 'application/octet-stream',
        body: bufferStream,
      },
      fields: 'id, name, mimeType, size, webViewLink, webContentLink, thumbnailLink, createdTime',
    });
    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    }).catch(() => {});
    res.json(uploaded.data);
  } catch (e) {
    console.error('[upload] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── List files in a folder (for the preview grid) ───────────────────────
app.get('/folders/:folderId/files', async (req, res) => {
  try {
    const { folderId } = req.params;
    const drive = getDriveClient();
    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, webViewLink, webContentLink, thumbnailLink, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 200,
    });
    res.json({ files: list.data.files || [] });
  } catch (e) {
    console.error('[list] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete a file (in case someone uploads the wrong thing) ─────────────
app.delete('/files/:fileId', async (req, res) => {
  try {
    const drive = getDriveClient();
    await drive.files.delete({ fileId: req.params.fileId });
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HVN Drive Proxy listening on port ' + PORT));
