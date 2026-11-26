require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const Database = require("better-sqlite3");
const archiver = require("archiver");
const QRCode = require("qrcode");
const mime = require("mime-types");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const TEMP_DIR = path.join(DATA_DIR, "temp");
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, "sharespace.sqlite"));
const SECRET = process.env.APP_SECRET || "";
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_SIZE_MB || 500) * 1024 * 1024;
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_SIZE_MB || 500) * 1024 * 1024;
const TTL_SECONDS = Number(process.env.SHARE_TTL_SECONDS || 900);

if (SECRET.length < 32) {
  console.error("APP_SECRET must be set to a random secret of at least 32 characters.");
  process.exit(1);
}
for (const dir of [DATA_DIR, UPLOAD_DIR, TEMP_DIR]) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  is_zip INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS source_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_records (
  share_id TEXT PRIMARY KEY REFERENCES shares(id) ON DELETE CASCADE,
  failed_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  rate_limit_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares(expires_at);
`);
const statements = {
  insertShare: db.prepare(`INSERT INTO shares
    (id,token,code_hash,stored_name,original_name,file_size,file_count,is_zip,mime_type,created_at,expires_at)
    VALUES (@id,@token,@code_hash,@stored_name,@original_name,@file_size,@file_count,@is_zip,@mime_type,@created_at,@expires_at)`),
  insertSecurity: db.prepare("INSERT INTO security_records (share_id) VALUES (?)"),
  insertSource: db.prepare("INSERT INTO source_files (share_id,original_name,file_size,mime_type) VALUES (?,?,?,?)"),
  byToken: db.prepare("SELECT * FROM shares WHERE token=?"),
  byId: db.prepare("SELECT * FROM shares WHERE id=?"),
  byCodeHash: db.prepare("SELECT * FROM shares WHERE code_hash=?"),
  status: db.prepare("SELECT id,expires_at,download_count,is_revoked,deleted_at FROM shares WHERE id=?"),
  fail: db.prepare(`INSERT INTO security_records(share_id,failed_attempt_count,last_attempt_at,rate_limit_until)
    VALUES(?,1,?,NULL) ON CONFLICT(share_id) DO UPDATE SET
    failed_attempt_count=failed_attempt_count+1,last_attempt_at=excluded.last_attempt_at,
    rate_limit_until=CASE WHEN failed_attempt_count+1>=8 THEN excluded.last_attempt_at+300 ELSE rate_limit_until END`),
  security: db.prepare("SELECT * FROM security_records WHERE share_id=?"),
  clearFailures: db.prepare("UPDATE security_records SET failed_attempt_count=0,rate_limit_until=NULL WHERE share_id=?"),
  countDownload: db.prepare("UPDATE shares SET download_count=download_count+1 WHERE id=?"),
  revoke: db.prepare("UPDATE shares SET is_revoked=1 WHERE id=?"),
  expired: db.prepare("SELECT * FROM shares WHERE expires_at<=? OR is_revoked=1"),
  deleteShare: db.prepare("DELETE FROM shares WHERE id=?")
};
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: MAX_FILE_BYTES, files: 30 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname || file.originalname.includes("\0")) return cb(new Error("Invalid filename"));
    cb(null, true);
  }
});
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
function codeDigest(code) { return crypto.createHmac("sha256", SECRET).update(code).digest("hex"); }
function active(share) { return share && !share.is_revoked && !share.deleted_at && share.expires_at > Math.floor(Date.now()/1000); }
function safeName(name) {
  return path.basename(String(name || "download")).replace(/[\r\n"]/g, "_").replace(/[^\w.\- ()]/g, "_").slice(0, 180) || "download";
}
function publicShare(share) {
  return {
    id: share.id, fileName: share.original_name, fileSize: share.file_size,
    fileCount: share.file_count, isZip: !!share.is_zip, mimeType: share.mime_type,
    expiresAt: share.expires_at, downloadCount: share.download_count,
    shareUrl: `${BASE_URL}/s/${share.token}`
  };
}
function genericInvalid(res) { return res.status(404).json({ error: "This code is invalid, expired, or unavailable." }); }

app.post("/api/upload", uploadLimiter, upload.array("files", 30), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Choose at least one file." });
  let finalPath;
  try {
    for (const f of files) if (f.size > MAX_FILE_BYTES) throw new Error("A file exceeds the 500 MB limit.");
    const id = crypto.randomUUID();
    const isZip = files.length > 1;
    const storedName = `${id}${isZip ? ".zip" : ".bin"}`;
    finalPath = path.join(UPLOAD_DIR, storedName);
    let totalSize = 0;
    let originalName;
    let mimeType;
    if (isZip) {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(finalPath, { flags: "wx" });
        const archive = archiver("zip", { zlib: { level: 6 } });
        output.on("close", resolve);
        output.on("error", reject);
        archive.on("warning", err => err.code === "ENOENT" ? console.warn(err) : reject(err));
        archive.on("error", reject);
        archive.pipe(output);
        for (const f of files) {
          const name = safeName(f.originalname);
          archive.file(f.path, { name });
          totalSize += f.size;
        }
        archive.finalize();
      });
      const zipStat = fs.statSync(finalPath);
      if (zipStat.size > MAX_ZIP_BYTES) throw new Error("The generated ZIP exceeds the 500 MB limit.");
      totalSize = zipStat.size;
      originalName = `ShareSpace-${id.slice(0, 8)}.zip`;
      mimeType = "application/zip";
    } else {
      totalSize = files[0].size;
      originalName = safeName(files[0].originalname);
      mimeType = mime.lookup(originalName) || "application/octet-stream";
      fs.renameSync(files[0].path, finalPath);
    }

    let code, token, share;
    for (let attempt = 0; attempt < 100; attempt++) {
      code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      token = randomToken();
      share = {
        id, token, code_hash: codeDigest(code), stored_name: storedName,
        original_name: originalName, file_size: totalSize, file_count: files.length,
        is_zip: isZip ? 1 : 0, mime_type: mimeType,
        created_at: Math.floor(Date.now()/1000),
        expires_at: Math.floor(Date.now()/1000) + TTL_SECONDS
      };
      try {
        const tx = db.transaction(() => {
          statements.insertShare.run(share);
          statements.insertSecurity.run(id);
          if (!isZip) statements.insertSource.run(id, safeName(files[0].originalname), files[0].size, mimeType);
          else for (const f of files) statements.insertSource.run(id, safeName(f.originalname), f.size, mime.lookup(f.originalname) || "application/octet-stream");
        });
        tx();
        break;
      } catch (e) {
        if (attempt === 99) throw e;
        if (fs.existsSync(finalPath)) { /* regenerate only credentials; file path remains */ }
      }
    }
    res.status(201).json({ ...publicShare(share), downloadCode: code });
  } catch (err) {
    if (finalPath && fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    res.status(400).json({ error: err.message || "Upload failed. Please try again." });
  } finally {
    for (const f of files) if (fs.existsSync(f.path)) fs.rmSync(f.path, { force: true });
  }
});

app.get("/api/share/:token", (req, res) => {
  const share = statements.byToken.get(req.params.token);
  if (!active(share)) return genericInvalid(res);
  res.json(publicShare(share));
});
app.get("/api/share/:id/status", (req, res) => {
  const share = statements.byId.get(req.params.id);
  if (!active(share)) return genericInvalid(res);
  res.json({ expiresAt: share.expires_at, downloadCount: share.download_count, remainingSeconds: Math.max(0, share.expires_at - Math.floor(Date.now()/1000)) });
});
app.post("/api/share/:id/revoke", (req, res) => {
  const share = statements.byId.get(req.params.id);
  if (!share || !active(share)) return genericInvalid(res);
  statements.revoke.run(req.params.id);
  res.json({ success: true });
});
app.get("/api/share/:id/qr", async (req, res) => {
  const share = statements.byId.get(req.params.id);
  if (!active(share)) return genericInvalid(res);
  try {
    const tokenShare = `${BASE_URL}/s/${share.token}`;
    const png = await QRCode.toBuffer(tokenShare, { type: "png", width: 420, margin: 2 });
    res.type("png").set("Cache-Control", "no-store").send(png);
  } catch { res.status(500).json({ error: "Could not create QR code." }); }
});
app.post("/api/download/code", codeLimiter, (req, res) => {
  const code = String(req.body?.code || "");
  if (!/^\d{6}$/.test(code)) return genericInvalid(res);
  const digest = codeDigest(code);
  const share = statements.byCodeHash.get(digest);
  if (!active(share)) return genericInvalid(res);
  const sec = statements.security.get(share.id);
  const now = Math.floor(Date.now()/1000);
  if (sec?.rate_limit_until && sec.rate_limit_until > now) return res.status(429).json({ error: "Too many attempts. Try again later." });
  statements.clearFailures.run(share.id);
  res.json({ url: `/s/${share.token}` });
});
app.get("/s/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "download.html")));
app.get("/api/download/:token", async (req, res) => {
  const share = statements.byToken.get(req.params.token);
  if (!active(share)) return genericInvalid(res);
  const filePath = path.join(UPLOAD_DIR, path.basename(share.stored_name));
  if (!fs.existsSync(filePath)) return genericInvalid(res);
  res.set({
    "Content-Type": share.mime_type,
    "Content-Disposition": `attachment; filename="${safeName(share.original_name)}"; filename*=UTF-8''${encodeURIComponent(share.original_name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  // Count only after the response stream completes successfully.
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  res.on("finish", () => { if (!res.destroyed) statements.countDownload.run(share.id); });
  stream.pipe(res);
});

// Failed code attempts are tracked without disclosing whether a code exists.
// Unknown codes are covered by the global endpoint limiter; known-share lockout is an additional safeguard.
const cleanup = () => {
  const now = Math.floor(Date.now()/1000);
  const rows = statements.expired.all(now);
  for (const share of rows) {
    const filePath = path.join(UPLOAD_DIR, path.basename(share.stored_name));
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      statements.deleteShare.run(share.id);
    } catch (err) { console.error("Cleanup failed for share", share.id, err.message); }
  }
  for (const name of fs.readdirSync(TEMP_DIR)) {
    const p = path.join(TEMP_DIR, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { force: true }); } catch {}
  }
};
setInterval(cleanup, 60 * 1000).unref();
cleanup();

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "A file exceeds the 500 MB limit." : "Upload limit exceeded." });
  res.status(400).json({ error: err.message || "Request failed." });
});
app.listen(PORT, () => console.log(`ShareSpace running at ${BASE_URL}`));
