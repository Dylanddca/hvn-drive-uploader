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

// ── Google Drive client ──────────────────────────────────────────────────
// IMPORTANT: Service accounts have ZERO storage quota of their own on a
// personal Gmail setup (no Google Workspace / Shared Drives available), so
// they can create folders but every upload fails with "Service Accounts do
// not have storage quota". The fix is to authenticate as a real Google
// account (yours) via OAuth2 instead — uploads then count against your
// normal 15GB+ Drive quota, same as if you'd uploaded them by hand.
//
// One-time setup to get here: visit GET /auth/google on this deployed
// service, sign in with the Google account you want files to live in,
// approve access, and it'll show you a refresh token to paste into
// GOOGLE_OAUTH_REFRESH_TOKEN below. See README.md for the full walkthrough.
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI; // e.g. https://your-app.up.railway.app/auth/google/callback
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

function getOAuth2Client() {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI env vars are not set — see README.md step 1.');
  }
  return new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
}

function getDriveClient() {
  // Preferred path: OAuth2 as a real Google account (works for personal Gmail).
  if (OAUTH_REFRESH_TOKEN) {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
    return google.drive({ version: 'v3', auth: oauth2Client });
  }
  // Legacy fallback: service account. Only viable if this Drive is on a
  // Google Workspace plan with Shared Drives / domain-wide delegation set up
  // — plain Gmail will hit "Service Accounts do not have storage quota" on
  // every upload.
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('Neither GOOGLE_OAUTH_REFRESH_TOKEN nor GOOGLE_SERVICE_ACCOUNT_JSON is set — see README.md.');
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

// ── One-time OAuth setup ─────────────────────────────────────────────────
// Visit this in a browser once, sign in with the Google account you want
// all script content to live in, and approve access. Not locked behind the
// admin key on purpose — it's meant to be opened directly in a browser, and
// it's useless to anyone without your Google login anyway.
app.get('/auth/google', (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline', // required to get a refresh_token back
      prompt: 'consent',      // forces a fresh refresh_token even if you've approved before
      scope: ['https://www.googleapis.com/auth/drive'],
    });
    res.redirect(url);
  } catch (e) {
    res.status(500).send('Setup error: ' + e.message);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing ?code from Google.');
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(200).send(
        'Got a token but no refresh_token — this usually means you\'d already ' +
        'granted access before. Go to https://myaccount.google.com/permissions, ' +
        'remove access for this app, then visit /auth/google again.'
      );
    }
    res.send(
      '<pre style="font-family:monospace;white-space:pre-wrap;word-break:break-all;padding:20px;">' +
      'Success! Copy this value into Railway as GOOGLE_OAUTH_REFRESH_TOKEN:\n\n' +
      tokens.refresh_token +
      '\n\nThen redeploy. You can close this tab after copying it.' +
      '</pre>'
    );
  } catch (e) {
    res.status(500).send('Token exchange error: ' + e.message);
  }
});

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
