// server.js
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const FormData = require("form-data");
require("dotenv").config();

const app = express();

// --- CORS & health ---
app.use(cors());
app.get("/health", (_req, res) => res.send("ok"));
app.options("/upload", cors());

// --- Multer: keep original filename in /uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

app.use(express.static("public"));

// --- helpers ---
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll Shopify until the file URL is ready
async function pollFileUrl({ store, token, id, maxAttempts = 12, intervalMs = 1000 }) {
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
    const resp = await axios.post(
      `https://${store}/admin/api/2025-01/graphql.json`,
      { query: gql, variables: { id } },
      { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
    );

    const node = resp.data?.data?.node;
    const url =
      node?.url ||
      node?.image?.url ||
      node?.preview?.image?.url ||
      null;

    if (url) return url;

    // small backoff to give Shopify time to process
    await wait(intervalMs);
  }
  throw new Error("Timeout: URL belum tersedia dari Shopify.");
}

// --- main upload endpoint ---
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    console.log("📂 File diterima:", req.file);

    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    if (!store || !token) {
      return res.status(500).json({ success: false, error: "SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN belum di-set." });
    }

    // Decide IMAGE vs FILE based on mimetype
    let resourceType = "FILE";
    let contentType = "FILE";
    if (req.file.mimetype?.startsWith("image/")) {
      resourceType = "IMAGE";
      contentType = "IMAGE";
    }
    console.log(`🧭 resourceType=${resourceType} contentType=${contentType} mime=${req.file.mimetype}`);

    // STEP 1: stagedUploadsCreate
    const stagedRes = await axios.post(
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
      }
    );

    const errors1 = stagedRes.data?.data?.stagedUploadsCreate?.userErrors || [];
    if (errors1.length) {
      console.error("❌ stagedUploadsCreate errors:", errors1);
      return res.status(500).json({ success: false, error: "stagedUploadsCreate gagal", details: errors1 });
    }

    const stagedTarget = stagedRes.data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!stagedTarget) {
      return res.status(500).json({ success: false, error: "Gagal membuat staged upload (stagedTarget kosong)." });
    }

    // STEP 2: POST ke signed URL (S3/GCS)
    const form = new FormData();
    stagedTarget.parameters.forEach((p) => form.append(p.name, p.value));
    form.append("file", fs.createReadStream(req.file.path));

    const s3Res = await axios.post(stagedTarget.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true, // accept 201/204/2xx
    });
    console.log("✅ Upload ke S3:", s3Res.status);

    if (s3Res.status < 200 || s3Res.status >= 300) {
      return res.status(500).json({ success: false, error: "Upload ke storage gagal", status: s3Res.status });
    }

    // STEP 3: Register file di Shopify
    const fileCreateRes = await axios.post(
      `https://${store}/admin/api/2025-01/graphql.json`,
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
      }
    );

    console.log("📩 Full response:", JSON.stringify(fileCreateRes.data, null, 2));

    const errors2 = fileCreateRes.data?.data?.fileCreate?.userErrors || [];
    if (errors2.length) {
      console.error("❌ fileCreate userErrors:", errors2);
      return res.status(500).json({ success: false, error: "fileCreate gagal", details: errors2 });
    }

    const uploadedFile = fileCreateRes.data?.data?.fileCreate?.files?.[0] || null;
    if (!uploadedFile) {
      return res.status(500).json({ success: false, error: "Tidak ada file object dari Shopify", raw: fileCreateRes.data });
    }

    // Try immediate URL first
    let fileUrl =
      uploadedFile?.url ||
      uploadedFile?.image?.url ||
      uploadedFile?.preview?.image?.url ||
      null;

    // If image is not ready yet, poll until ready
    if (!fileUrl && uploadedFile.id) {
      console.log("⏳ URL belum siap, polling node(id)...");
      try {
        fileUrl = await pollFileUrl({ store, token, id: uploadedFile.id, maxAttempts: 12, intervalMs: 1000 });
      } catch (e) {
        console.error("⚠️ URL masih kosong setelah polling:", e.message);
      }
    }

    if (!fileUrl) {
      console.error("⚠️ URL kosong:", uploadedFile);
      return res.status(500).json({ success: false, error: "Response tidak berisi URL file", uploadedFile });
    }

    console.log("✅ Uploaded ke Shopify:", fileUrl);
    return res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error("❌ Error upload:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Gagal upload ke Shopify" });
  }
});

// --- start server ---
app.listen(3002, () => {
  console.log("✅ Server jalan di http://localhost:3002");
});
