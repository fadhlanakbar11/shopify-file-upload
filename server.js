// server.js — versi rapi & aman + support rename via webhook
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
require("dotenv").config();

const app = express();

// ====== Konfigurasi umum ======
app.use(cors());
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pastikan folder uploads/ ada
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

// Axios default (timeout biar gak gantung)
const ax = axios.create({ timeout: 30_000 });

// ====== Multer (simpan file sementara di disk) ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const fieldName = req.body.fieldName || "field";
    const index = req.body.index || "0";
    const q = req.body.q || "0";
    const ext = path.extname(file.originalname);

    const safeField = fieldName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const newName = `INV_VISA_${safeField}_${index}_${q}${ext}`;

    cb(null, newName); // hasil rename disimpan sebagai req.file.filename
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ====== Helper kecil ======
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollFileUrl({
  store,
  token,
  id,
  maxAttempts = 12,
  intervalMs = 1000,
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await ax.post(
      `https://${store}/admin/api/2025-01/graphql.json`,
      { query: gql, variables: { id } },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );
    const node = resp.data?.data?.node;
    const url =
      node?.url || node?.image?.url || node?.preview?.image?.url || null;
    if (url) return url;
    await wait(intervalMs);
  }
  throw new Error("Timeout: URL belum tersedia dari Shopify.");
}

// ====== Endpoint utama upload ======
app.post("/upload", upload.single("file"), async (req, res) => {
  let tempPath;
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Tidak ada file yang diunggah (field name harus 'file').",
        });
    }
    tempPath = req.file.path;
    console.log(
      "📂 File diterima:",
      req.file.filename,
      req.file.mimetype,
      req.file.size
    );

    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    if (!store || !token) {
      return res.status(500).json({
        success: false,
        error: "SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN belum di-set.",
      });
    }

    const isImage = req.file.mimetype?.startsWith("image/");
    const resourceType = isImage ? "IMAGE" : "FILE";
    const contentType = isImage ? "IMAGE" : "FILE";

    // STEP 1: stagedUploadsCreate
    const stagedRes = await ax.post(
      `https://${store}/admin/api/2025-01/graphql.json`,
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
              filename: req.file.filename, // pakai nama sudah di-rename
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
      }
    );

    const errors1 = stagedRes.data?.data?.stagedUploadsCreate?.userErrors || [];
    if (errors1.length) {
      console.error("❌ stagedUploadsCreate errors:", errors1);
      return res
        .status(502)
        .json({
          success: false,
          error: "stagedUploadsCreate gagal",
          details: errors1,
        });
    }

    const stagedTarget =
      stagedRes.data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!stagedTarget) {
      return res
        .status(502)
        .json({
          success: false,
          error: "Gagal membuat staged upload (stagedTarget kosong).",
        });
    }

    // STEP 2: Upload ke storage (S3/GCS)
    const form = new FormData();
    stagedTarget.parameters.forEach((p) => form.append(p.name, p.value));
    form.append("file", fs.createReadStream(tempPath));

    const s3Res = await ax.post(stagedTarget.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
    console.log("✅ Upload ke storage:", s3Res.status);

    if (s3Res.status < 200 || s3Res.status >= 300) {
      return res
        .status(502)
        .json({
          success: false,
          error: "Upload ke storage gagal",
          status: s3Res.status,
        });
    }

    // STEP 3: Register file di Shopify
    const fileCreateRes = await ax.post(
      `https://${store}/admin/api/2025-01/graphql.json`,
      {
        query: `
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                __typename
                id
                alt
                ... on MediaImage { image { url } preview { image { url } } }
                ... on GenericFile { url }
              }
              userErrors { field message }
            }
          }
        `,
        variables: {
          files: [
            {
              alt: req.file.filename,
              contentType,
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
      }
    );

    const errors2 = fileCreateRes.data?.data?.fileCreate?.userErrors || [];
    if (errors2.length) {
      console.error("❌ fileCreate userErrors:", errors2);
      return res
        .status(502)
        .json({ success: false, error: "fileCreate gagal", details: errors2 });
    }

    const uploadedFile =
      fileCreateRes.data?.data?.fileCreate?.files?.[0] || null;
    if (!uploadedFile) {
      return res
        .status(502)
        .json({
          success: false,
          error: "Tidak ada file object dari Shopify",
          raw: fileCreateRes.data,
        });
    }

    let fileUrl =
      uploadedFile?.url ||
      uploadedFile?.image?.url ||
      uploadedFile?.preview?.image?.url ||
      null;

    if (!fileUrl && uploadedFile.id) {
      console.log("⏳ URL belum siap, polling node(id)...");
      try {
        fileUrl = await pollFileUrl({
          store,
          token,
          id: uploadedFile.id,
          maxAttempts: 12,
          intervalMs: 1000,
        });
      } catch (e) {
        console.error("⚠️ URL masih kosong setelah polling:", e.message);
      }
    }

    if (!fileUrl) {
      return res
        .status(502)
        .json({
          success: false,
          error: "Response tidak berisi URL file",
          uploadedFile,
        });
    }

    console.log("✅ Uploaded ke Shopify:", fileUrl);
    return res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error("❌ Error upload:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ success: false, error: "Gagal upload ke Shopify" });
  } finally {
    if (tempPath) {
      fs.promises.unlink(tempPath).catch(() => {});
    }
  }
});

// ====== Webhook orders/create ======
app.post("/webhook/orders-create", async (req, res) => {
  try {
    const order = req.body;
    const orderNumber = order.name?.replace("#", "JT-") || "JT-UNKNOWN";
    const cartToken = order.cart_token;

    console.log("🧾 Order baru:", orderNumber, "cartToken:", cartToken);

    // TODO: cari file lama (pakai cartToken) lalu re-upload pakai orderNumber
    // contoh nama final: INV_VISA_field_JT-1234_0_1.jpg

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error webhook orders-create:", err.message);
    res.sendStatus(500);
  }
});

// ====== Start server ======
const PORT = process.env.PORT || 3002;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`✅ http://${HOST}:${PORT}`));
