const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

const mappingPath = path.join(__dirname, "uploads", "mapping.json");
if (!fs.existsSync(mappingPath)) {
  fs.writeFileSync(mappingPath, "{}");
}

const ax = axios.create({ timeout: 30_000 });

/* ================== Webhook orders/create ================== */
app.post(
  "/webhook/orders-create", express.raw({ type: "application/json" }), async (req, res) => {
    console.log("📥 Webhook received");
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body.toString("utf8");
      console.log("Order data:", body);  // tambahkan ini

      // verifikasi HMAC
      const hash = crypto
        .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmac) {
        console.error("❌ HMAC tidak valid");
        return res.status(401).send("Unauthorized");
      }

      // parse order
      const order = JSON.parse(body);
      const orderNumber = order.name?.replace("#", "JT-") || "JT-UNKNOWN";
      const cartToken = order.cart_token;

      console.log("🧾 Order baru:", orderNumber, "cartToken:", cartToken);

      // ambil mapping file lama
      let mapping = {};
      if (fs.existsSync(mappingPath)) {
        mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
      }

      const files = mapping[cartToken] || [];
      if (files.length === 0) {
        console.log("⚠️ Tidak ada file untuk cartToken ini");
        return res.sendStatus(200);
      }

      const store = process.env.SHOPIFY_STORE_DOMAIN;
      const token = process.env.SHOPIFY_ADMIN_API_TOKEN;

      for (const oldName of files) {
        const localPath = path.join(__dirname, "uploads", oldName);
        if (!fs.existsSync(localPath)) {
          console.warn("⚠️ File tidak ditemukan:", localPath);
          continue;
        }

        const ext = path.extname(oldName);
        const base = path.basename(oldName, ext);
        const parts = base.split("_");

        // nama baru: INV_VISA_field_JT-1234_index_q.ext
        const safeField = parts[2] || "field";
        const index = parts[3] || "0";
        const q = parts[4] || "0";
        const newName = `INV_VISA_${safeField}_${orderNumber}_${index}_${q}${ext}`;

        console.log(`⬆️ Re-upload ${oldName} → ${newName}`);

        // === Upload ulang ke Shopify ===
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
                  filename: newName,
                  mimeType: "image/jpeg", // ganti sesuai kebutuhan
                  resource: "IMAGE",
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

        const stagedTarget =
          stagedRes.data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
        if (!stagedTarget) {
          console.error("❌ stagedUploadsCreate gagal:", stagedRes.data);
          continue;
        }

        const form = new FormData();
        stagedTarget.parameters.forEach((p) => form.append(p.name, p.value));
        form.append("file", fs.createReadStream(localPath));

        const s3Res = await ax.post(stagedTarget.url, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        console.log("✅ Upload ke storage:", s3Res.status);

        // daftar file ke Shopify
        const fileCreateRes = await ax.post(
          `https://${store}/admin/api/2025-01/graphql.json`,
          {
            query: `
              mutation fileCreate($files: [FileCreateInput!]!) {
                fileCreate(files: $files) {
                  files { id alt ... on GenericFile { url } ... on MediaImage { image { url } } }
                  userErrors { field message }
                }
              }
            `,
            variables: {
              files: [
                {
                  alt: newName,
                  contentType: "IMAGE",
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

        const uploadedFile =
          fileCreateRes.data?.data?.fileCreate?.files?.[0] || null;
        if (uploadedFile) {
          console.log("🎉 Re-upload berhasil:", uploadedFile.id);
        } else {
          console.error("❌ fileCreate gagal:", fileCreateRes.data);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Error webhook orders-create:", err.message);
      res.sendStatus(500);
    }
  }
);

/* ================== Konfigurasi umum ================== */
app.use(cors());
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================== Multer ================== */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const fieldName = req.body.fieldName || "field";
    const index = req.body.index || "0";
    const q = req.body.q || "0";
    const ext = path.extname(file.originalname);

    const safeField = fieldName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const newName = `INV_VISA_${safeField}_${index}_${q}${ext}`;

    cb(null, newName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

/* ================== Helper polling ================== */
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

/* ================== Endpoint utama upload ================== */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Tidak ada file yang diunggah (field name harus 'file').",
      });
    }
    console.log("📂 File diterima:", req.file.filename, req.file.mimetype, req.file.size);

    const cartToken = req.body.cartToken || "UNKNOWN";
    let mapping = {};
    if (fs.existsSync(mappingPath)) {
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
    }
    if (!mapping[cartToken]) mapping[cartToken] = [];
    mapping[cartToken].push(req.file.filename);
    fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));

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

    // staged upload
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
              filename: req.file.filename,
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

    const stagedTarget =
      stagedRes.data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!stagedTarget) {
      return res.status(502).json({
        success: false,
        error: "Gagal membuat staged upload (stagedTarget kosong).",
      });
    }

    const form = new FormData();
    stagedTarget.parameters.forEach((p) => form.append(p.name, p.value));
    form.append("file", fs.createReadStream(req.file.path));

    const s3Res = await ax.post(stagedTarget.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
    console.log("✅ Upload ke storage:", s3Res.status);

    // fileCreate
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

    const uploadedFile =
      fileCreateRes.data?.data?.fileCreate?.files?.[0] || null;

    let fileUrl =
      uploadedFile?.url ||
      uploadedFile?.image?.url ||
      uploadedFile?.preview?.image?.url ||
      null;

    if (!fileUrl && uploadedFile?.id) {
      console.log("⏳ Polling file URL...");
      fileUrl = await pollFileUrl({ store, token, id: uploadedFile.id });
    }

    if (!fileUrl) {
      return res.status(502).json({
        success: false,
        error: "Response tidak berisi URL file",
        uploadedFile,
      });
    }

    console.log("✅ Uploaded ke Shopify:", fileUrl);
    return res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error("❌ Error upload:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Gagal upload ke Shopify" });
  }
});

/* ================== Start server ================== */
const PORT = process.env.PORT || 3002;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`✅ Server running at http://${HOST}:${PORT}`));
