# ShareSpace

A full-stack temporary file-sharing application. Upload a single file in its original format, or upload multiple files to package them into one ZIP. Each share has three access methods that point to the same share record and file:

1. A unique, unguessable sharing URL
2. A QR code containing that URL
3. A unique six-digit numeric download code

All three methods expire at the same timestamp (15 minutes after creation by default). Downloading does not extend the expiration.

## Features

- Responsive upload and download interface
- Drag-and-drop and multi-file upload
- 500 MB maximum per uploaded file
- 500 MB maximum generated ZIP
- Single file remains unzipped; multiple files are archived
- Cryptographically generated 256-bit URL token
- Six-digit code generation with leading-zero support and HMAC-SHA256 storage
- QR PNG generation
- Download page with file information and expiration countdown
- Copy link and code, download QR, revoke share
- Private local file storage; raw storage paths are never exposed
- Automatic cleanup every minute
- Rate limiting on upload and code-validation endpoints
- SQLite persistence, foreign keys, and unique constraints
- Basic security headers and safe download filenames

## Requirements

- Node.js 20 or later
- npm

## Run locally

```bash
# 1. Extract this ZIP and enter the project directory
cd ShareSpace

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env
```

Edit `.env` and set `APP_SECRET` to a long random secret. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then start the application:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For development with automatic server restart:

```bash
npm run dev
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `BASE_URL` | Public base URL used in sharing links | `http://localhost:3000` |
| `DATA_DIR` | Private data directory | `./data` |
| `DB_FILE` | SQLite database file | `./data/sharespace.sqlite` |
| `APP_SECRET` | HMAC secret for protecting download codes | Required, 32+ characters |
| `MAX_FILE_SIZE_MB` | Maximum size of each incoming file | `500` |
| `MAX_ZIP_SIZE_MB` | Maximum generated ZIP size | `500` |
| `SHARE_TTL_SECONDS` | Share lifetime | `900` |

## How it works

### Upload

- The server validates upload limits.
- One uploaded file is moved into private storage without ZIP conversion.
- Multiple uploaded files are archived into one ZIP file.
- The server creates one SQLite share record and one expiration timestamp.
- The server generates a unique token, QR code on demand, and six-digit code.

### Download

- Link and QR access resolve to `/s/:token`.
- A six-digit code is submitted to `/api/download/code`, which validates it and returns the matching share page.
- The download endpoint re-checks that the share is active and the stored file exists.
- Download count is incremented after the response finishes.

### Expiration and revocation

- The cleanup task runs every minute.
- Expired and revoked shares are removed from the database and their stored files are deleted.
- Revocation invalidates the shared link, QR destination, and download code because all three rely on the same share record.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Upload file(s), create share |
| `GET` | `/api/share/:token` | Validate link and return safe metadata |
| `POST` | `/api/download/code` | Validate six-digit code |
| `GET` | `/api/download/:token` | Download stored file |
| `GET` | `/api/share/:id/status` | Read expiry and download count |
| `POST` | `/api/share/:id/revoke` | Revoke share |
| `GET` | `/api/share/:id/qr` | Generate QR PNG |

## Important security and production notes

This is a runnable local project starter, not a security-audited production service. Before exposing it to the public internet:

- Put it behind HTTPS and a reverse proxy configured for large request bodies and long uploads.
- Use a persistent private volume for `data/`; do not serve it as static content.
- Set `BASE_URL` to the public HTTPS origin and use a strong, unique `APP_SECRET`.
- Add authentication or a separate unguessable owner-management credential before allowing share revocation. The current revoke route uses the opaque share ID as its capability.
- Add robust per-IP and per-code attempt tracking for unknown codes, ideally with a shared store such as Redis. The included global limiter is a baseline; the per-share failure table is scaffolded for extension.
- For high concurrency and very large uploads, move ZIP creation to a streaming/background worker and consider object storage with private access.
- Configure request body limits, disk quotas, malware scanning, monitoring, backups, and log retention.
- Review proxy timeout and maximum body-size settings. A 500 MB upload may fail if the hosting platform has a lower limit.
- Test simultaneous uploads/downloads and cleanup behavior on the target operating system and deployment platform.

## Project structure

```text
ShareSpace/
├── public/
│   ├── app.js
│   ├── download.html
│   ├── download.js
│   ├── index.html
│   ├── result.html
│   ├── result.js
│   └── styles.css
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── server.js
```

## Current limitations

- The app uses SQLite and local disk storage; it is intended for a single-server deployment.
- ZIP output is created on disk before it is made available for download.
- The UI uses a Google Fonts import; system fonts remain as fallback, but the remote font itself is not offline.
- Automated test suites and database migration tooling are not included in this initial project package.
- No public file URLs are exposed; downloads are served through the application backend.
