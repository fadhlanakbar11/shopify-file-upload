// server.js
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const FormData = require("form-data");
require("dotenv").config();

const app = express();

/* ---------- CORS & health ---------- */
// (opsional) batasi ke domain toko kamu via ENV: ALLOWED_ORIGINS="https://toko.myshopify.com,https://domainmu.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!ALLOWED_ORIGINS.length) return cb(null, true); // allow all if not set
      if (!origin) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
  })
);

app.get("/health", (_req, res) => res.send("ok"));
app.options("/upload", cors());

/* ---------- Multer: simpan nama asli di /uploads ---------- */
fs.mkdirSync("uploads", { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  // (opsional) batasi ukuran, misal 12MB:
  // limits: { fileSize: 12 * 1024 * 1024 },
});

app.use(express.static("public"));

/* ---------- Helpers ---------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polling node(id) sampai URL siap, dengan exponential backoff.
 * maxAttempts default 20, startDelayMs 800ms, factor 1.6
 */
async function pollFileUrl({
  store,
  token,
  id,
  maxAttempts = 20,
  startDelayMs = 800,
  factor = 1.6,
}) {
  const gql = `
    query fileNode($id: ID!) {
      node(id: $id) {
        __typename
        ... on MediaImage {
          image { url }
          preview { image { url } }
        }
        ... on GenericFile {
          url
        }
      }
    }
  `;

  let delay = startDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await axios.post(
      `https://${store}/admin/api/${process.env.SHOPIFY_API_VERSION || "2025-01"}/graphql.json`,
      { query: gql, variables: { id } },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    const node = resp.data?.data?.node;
    const url = node?.url || node?.image?.url || node?.preview?.image?.url || null;

    if (url) return url;

    await wait(delay);
    delay = Math.min(Math.round(delay * factor), 8000); // cap 8s
  }
  throw new Error("Timeout: URL belum tersedia dari Shopify.");
}

/* ---------- Main upload endpoint ---------- */
app.post("/upload", upload.single("file"), async (req, res) => {
  const tmpPath = req.file?.path; // untuk cleanup
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Tidak ada file di request." });
    }

    console.log("📂 File diterima:", req.file);
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-01";

    if (!store || !token) {
      return res.status(500).json({
        success: false,
        error: "SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN belum di-set.",
      });
    }

    // Tentukan tipe (IMAGE vs FILE)
    let resourceType = "FILE";
    let contentType = "FILE";
    if (req.file.mimetype?.startsWith("image/")) {
      resourceType = "IMAGE";
      contentType = "IMAGE";
    }
    console.log(`🧭 resourceType=${resourceType} contentType=${contentType} mime=${req.file.mimetype}`);

    // STEP 1: stagedUploadsCreate
    const stagedRes = await axios.post(
      `https://${store}/admin/api/${apiVersion}/graphql.json`,
      {
        query: `
          mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets {
                url
                resourceUrl
                parameters { name value }
              }
              userErrors { field message }
            }
          }
        `,
        variables: {
          input: [
            {
              filename: req.file.originalname,
              mimeType: req.file.mimetype,
              resource: resourceType,
              httpMethod: "POST",
            },
          ],
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    const errors1 = stagedRes.data?.data?.stagedUploadsCreate?.userErrors || [];
    if (errors1.length) {
      console.error("❌ stagedUploadsCreate errors:", errors1);
      return res.status(502).json({ success: false, error: "stagedUploadsCreate gagal", details: errors1 });
    }

    const stagedTarget = stagedRes.data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!stagedTarget) {
      return res.status(502).json({ success: false, error: "Gagal membuat staged upload (stagedTarget kosong)." });
    }

    // STEP 2: Upload ke signed URL (S3/GCS)
    const form = new FormData();
    stagedTarget.parameters.forEach((p) => form.append(p.name, p.value));
    form.append("file", fs.createReadStream(req.file.path));

    const s3Res = await axios.post(stagedTarget.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
      validateStatus: () => true, // accept any 2xx
    });
    console.log("✅ Upload ke storage:", s3Res.status);

    if (s3Res.status < 200 || s3Res.status >= 300) {
      return res.status(502).json({ success: false, error: "Upload ke storage gagal", status: s3Res.status });
    }

    // STEP 3: Register file di Shopify (fileCreate)
    const fileCreateRes = await axios.post(
      `https://${store}/admin/api/${apiVersion}/graphql.json`,
      {
        query: `
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                __typename
                id
                alt
                ... on MediaImage {
                  image { url }
                  preview { image { url } }
                }
                ... on GenericFile {
                  url
                }
              }
              userErrors { field message }
            }
          }
        `,
        variables: {
          files: [
            {
              alt: "Uploaded via Node.js",
              contentType: contentType,
              originalSource: stagedTarget.resourceUrl,
            },
          ],
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    console.log("📩 Full response:", JSON.stringify(fileCreateRes.data, null, 2));

    const errors2 = fileCreateRes.data?.data?.fileCreate?.userErrors || [];
    if (errors2.length) {
      console.error("❌ fileCreate userErrors:", errors2);
      return res.status(502).json({ success: false, error: "fileCreate gagal", details: errors2 });
    }

    const uploadedFile = fileCreateRes.data?.data?.fileCreate?.files?.[0] || null;
    if (!uploadedFile) {
      return res.status(502).json({ success: false, error: "Tidak ada file object dari Shopify", raw: fileCreateRes.data });
    }

    // Coba URL langsung
    let fileUrl =
      uploadedFile?.url ||
      uploadedFile?.image?.url ||
      uploadedFile?.preview?.image?.url ||
      null;

    // Jika belum ada, polling node(id) sampai siap
    if (!fileUrl && uploadedFile.id) {
      console.log("⏳ URL belum siap, polling node(id)...");
      try {
        fileUrl = await pollFileUrl({ store, token, id: uploadedFile.id });
      } catch (e) {
        console.error("⚠️ URL masih kosong setelah polling:", e.message);
      }
    }

    if (!fileUrl) {
      console.error("⚠️ URL kosong:", uploadedFile);
      return res.status(502).json({ success: false, error: "Response tidak berisi URL file", uploadedFile });
    }

    console.log("✅ Uploaded ke Shopify:", fileUrl);
    return res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error("❌ Error upload:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Gagal upload ke Shopify" });
  } finally {
    // bersihkan file sementara
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
});

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server jalan di http://localhost:${PORT}`);
});
