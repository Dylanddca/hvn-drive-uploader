# HVN Drive Proxy

Small backend that lets the Sexting Scripts feature in HVN Heaven create a
Google Drive folder per model, let the model upload content into it by
dragging files onto her link (no Google account needed on her end), and let
the app show previews / download links for what's in there.

It never touches the model's files except to relay them straight to Drive —
nothing is stored on this server.

## 1. Google Cloud setup (one-time, ~15-20 min)

1. Go to https://console.cloud.google.com and create a new project (any name,
   e.g. "HVN Drive").
2. In the search bar, search for **"Google Drive API"** and click **Enable**.
3. In the left sidebar: **IAM & Admin → Service Accounts → Create Service Account**.
   - Name it anything, e.g. `hvn-drive-uploader`.
   - Skip the optional "grant access" steps, just click through to **Done**.
4. Click into the service account you just created → **Keys** tab →
   **Add Key → Create new key → JSON**. This downloads a `.json` file —
   keep it safe, you'll paste its contents into Railway in step 3 below.
5. Open that downloaded JSON file in a text editor and copy the value of the
   `"client_email"` field (looks like `something@your-project.iam.gserviceaccount.com`).
6. In Google Drive, create (or pick) the folder where you want all the
   per-model script folders to live. Right-click it → **Share** → paste that
   `client_email` address in → give it **Editor** access → Send.
7. Open that same parent folder and copy its ID from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART`** — you'll need
   this for `DRIVE_PARENT_FOLDER_ID`.

## 2. Deploy to Railway

1. Create a new project on Railway → **Deploy from GitHub repo** (push this
   folder to a new repo first) or use **Railway CLI** / drag-and-drop deploy
   if you prefer — either way, just get these files onto a Railway service.
2. Once deployed, Railway will give you a public URL like
   `https://hvn-drive-proxy-production.up.railway.app`. Keep that handy.

## 3. Environment variables (set these in Railway → your service → Variables)

- `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the **entire contents** of the JSON
  key file from step 1.4, all on one line.
- `DRIVE_PARENT_FOLDER_ID` — the folder ID from step 1.7.
- `PROXY_API_KEY` — make up any long random string. This is what locks down
  folder creation so only your app can do it.

## 4. Test it

Once deployed with those variables set:

```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/
# should reply: HVN Drive Proxy is running.

curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/folders \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -d '{"name":"Test Folder"}'
# should reply with {"folderId": "...", "folderUrl": "..."} and you should
# see a new "Test Folder" appear inside your Drive parent folder.
```

If that works, you're done on this side — send me the Railway URL and the
`PROXY_API_KEY` you chose, and I'll wire up the HVN Hub frontend to talk to
it (creating a folder when a script is made, and the drag-and-drop /
preview grid on both the admin view and the model's link).

## Endpoints reference

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
