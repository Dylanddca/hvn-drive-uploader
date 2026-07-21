# HVN Drive Proxy

Small backend that lets the Sexting Scripts feature in HVN Heaven create a
Google Drive folder per model, let the model upload content into it by
dragging files onto her link (no Google account needed on her end), and let
the app show previews / download links for what's in there.

It never touches the model's files except to relay them straight to Drive —
nothing is stored on this server.

## ⚠️ Why uploads were failing

The original setup authenticated as a **service account**. Service accounts
have **zero storage quota of their own** — on a personal Gmail account
(no Google Workspace) there's no Shared Drive to put them in and no way to
grant them borrowed quota. Folders could be created (that's a metadata
operation), but every actual file upload failed with:

```
Service Accounts do not have storage quota. Leverage shared drives...
```

The fix: authenticate as **your real Google account** via OAuth2 instead.
Uploads then count against your normal Drive storage, exactly as if you'd
dragged the file in yourself.

## 1. Google Cloud setup (one-time, ~15 min)

1. Go to https://console.cloud.google.com and create a project (or reuse the
   one you already made for the service account / model-upload OAuth flow).
2. Search for **"Google Drive API"** and click **Enable** (skip if already
   enabled).
3. Left sidebar → **APIs & Services → Credentials → Create Credentials →
   OAuth client ID**.
   - If prompted, configure the **OAuth consent screen** first: User Type
     "External" is fine, fill in an app name, your email for support/contact,
     and add your own Google account under **Test users** (this keeps the
     app in "Testing" mode, which is fine — no Google review needed as long
     as you're the only user).
   - Application type: **Web application**.
   - Name it anything, e.g. `hvn-drive-proxy`.
   - Under **Authorized redirect URIs**, add:
     `https://YOUR-RAILWAY-URL.up.railway.app/auth/google/callback`
     (use your actual Railway URL — you can add this after step 2 if you
     don't have it yet, then come back and edit the OAuth client).
   - Click **Create**. Copy the **Client ID** and **Client secret** shown —
     you'll need both for Railway.
4. In Google Drive, create (or pick) the folder where all the per-model
   script folders should live, using the **same Google account** you'll
   authorize in step 4 below. Copy its ID from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART`** — you'll need
   this for `DRIVE_PARENT_FOLDER_ID`.

## 2. Deploy to Railway

1. Create a new project on Railway → **Deploy from GitHub repo** (push this
   folder to a new repo first) or use **Railway CLI** / drag-and-drop deploy.
2. Once deployed, Railway gives you a public URL like
   `https://hvn-drive-proxy-production.up.railway.app`. Keep that handy —
   and make sure it matches the redirect URI you set in step 1.3.

## 3. Environment variables (Railway → your service → Variables)

- `GOOGLE_OAUTH_CLIENT_ID` — from step 1.3.
- `GOOGLE_OAUTH_CLIENT_SECRET` — from step 1.3.
- `GOOGLE_OAUTH_REDIRECT_URI` — `https://YOUR-RAILWAY-URL.up.railway.app/auth/google/callback`
- `DRIVE_PARENT_FOLDER_ID` — the folder ID from step 1.4.
- `PROXY_API_KEY` — make up any long random string. This locks down folder
  creation so only your app can do it.
- `GOOGLE_OAUTH_REFRESH_TOKEN` — leave this **empty for now**, you'll get it
  in step 4 below and add it after.

Deploy with these set (refresh token still missing is fine for this step).

## 4. Get your refresh token (one-time, ~1 min)

1. Visit `https://YOUR-RAILWAY-URL.up.railway.app/auth/google` in a browser.
2. Sign in with the Google account whose Drive you want the files to live in
   (must be a **Test user** you added in step 1.3 if the consent screen is
   still in "Testing" mode).
3. Approve access. You'll land on a page showing a long token string.
4. Copy it into Railway as `GOOGLE_OAUTH_REFRESH_TOKEN`, save, let it
   redeploy.

That's it — uploads now go through your real account.

## 5. Test it

```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/
# should reply: HVN Drive Proxy is running.

curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/folders \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -d '{"name":"Test Folder"}'
# should reply with {"folderId": "...", "folderUrl": "..."}

curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/folders/FOLDER_ID_FROM_ABOVE/upload \
  -F "file=@/path/to/any/small/test/file.jpg"
# should reply with the file's Drive metadata — then check the folder in
# Drive and confirm the file is actually there.
```

## Endpoints reference

- `GET /auth/google` *(open in a browser, one-time setup)* — starts the
  OAuth consent flow.
- `GET /auth/google/callback` — OAuth redirect target, shows your refresh
  token after you approve access.
- `POST /folders` *(needs `x-api-key` header)* — `{ name }` → creates a Drive
  folder, returns `{ folderId, folderUrl }`.
- `POST /folders/:folderId/upload` — multipart form with a `file` field →
  uploads into that folder, returns the file's Drive metadata.
- `GET /folders/:folderId/files` — lists everything in that folder (for
  building a preview grid).
- `DELETE /files/:fileId` — removes a file, in case something gets uploaded
  by mistake.

Upload/list/delete don't require the API key — the folder ID itself is the
"capability" (same trust model as the share links already used elsewhere in
the app: not publicly discoverable, but no login wall either, since the
model doesn't have an account).
