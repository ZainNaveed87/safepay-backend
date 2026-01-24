// paypro-backend/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";

// -------------------- OPTIONAL: Firebase Admin (REQUIRED for auto receipt + order update) --------------------
let admin = null;
let firestore = null;

async function initFirebaseAdmin() {
  if (firestore) return firestore;

  const svcJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!svcJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");

  // dynamic import (but you MUST have firebase-admin installed)
  const mod = await import("firebase-admin");
  admin = mod.default || mod;

  if (!admin.apps?.length) {
    const creds = JSON.parse(svcJson);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
  }

  firestore = admin.firestore();
  return firestore;
}

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 5050);

const FRONTEND_ORIGINS_RAW = process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const FRONTEND_ORIGINS = FRONTEND_ORIGINS_RAW.split(",").map(s => s.trim()).filter(Boolean);

// ---- PayPro ENV ----
const PAYPRO_BASE_URL = (process.env.PAYPRO_BASE_URL || "").replace(/\/$/, "");
const PAYPRO_CLIENT_ID = (process.env.PAYPRO_CLIENT_ID || "").trim();
const PAYPRO_CLIENT_SECRET = (process.env.PAYPRO_CLIENT_SECRET || "").trim();

const PAYPRO_MERCHANT_ID =
  (process.env.PAYPRO_MERCHANT_ID || process.env.PAYPRO_USERNAME || "").trim();

const PAYPRO_RETURN_URL = process.env.PAYPRO_RETURN_URL || "http://localhost:8080/payment/success";
const PAYPRO_CANCEL_URL = process.env.PAYPRO_CANCEL_URL || "http://localhost:8080/payment/cancel";

const PAYPRO_AUTH_PATH = (process.env.PAYPRO_AUTH_PATH || "/v2/ppro/auth").trim();
const PAYPRO_CREATE_ORDER_PATH = (process.env.PAYPRO_CREATE_ORDER_PATH || "/v2/ppro/co").trim();

// PayPro callback creds
const PAYPRO_CALLBACK_USERNAME =
  (process.env.PAYPRO_CALLBACK_USERNAME || process.env.PAYPRO_USERNAME || "").trim();
const PAYPRO_CALLBACK_PASSWORD = (process.env.PAYPRO_CALLBACK_PASSWORD || "").trim();

// ---- Resend ENV ----
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RECEIPT_FROM_EMAIL = (process.env.RECEIPT_FROM_EMAIL || "").trim();
const RECEIPT_FROM_NAME = (process.env.RECEIPT_FROM_NAME || "Secrets Discounts").trim();

// -------------------- Middleware --------------------
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));

// -------------------- Utils --------------------
function requireEnvOrThrow() {
  const missing = [];
  if (!PAYPRO_BASE_URL) missing.push("PAYPRO_BASE_URL");
  if (!PAYPRO_CLIENT_ID) missing.push("PAYPRO_CLIENT_ID");
  if (!PAYPRO_CLIENT_SECRET) missing.push("PAYPRO_CLIENT_SECRET");
  if (!PAYPRO_MERCHANT_ID) missing.push("PAYPRO_MERCHANT_ID (or PAYPRO_USERNAME)");
  if (missing.length) {
    const err = new Error(`Missing env: ${missing.join(", ")}`);
    err.statusCode = 500;
    throw err;
  }
}

function makeUrl(base, pathOrUrl) {
  const raw = (pathOrUrl || "").trim();
  if (!raw) return base;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, "");
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${p}`;
}

function stringifySafe(v) {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isHtmlResponse(headers, body) {
  const ct = String(headers?.["content-type"] || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  if (typeof body === "string") {
    const t = body.trim().toLowerCase();
    if (t.startsWith("<!doctype html") || t.startsWith("<html")) return true;
  }
  return false;
}

function looksLikeInvalidKeys(body) {
  const s = String(body || "").trim().toLowerCase();
  return s.includes("invalid keys") || s.includes("invalid key");
}

function detectTokenFromHeaders(headers) {
  if (!headers) return null;
  return (
    headers["token"] ||
    headers["Token"] ||
    headers["TOKEN"] ||
    headers["x-token"] ||
    headers["X-Token"] ||
    headers["x-auth-token"] ||
    headers["X-Auth-Token"] ||
    headers["access-token"] ||
    headers["Access-Token"] ||
    null
  );
}

function detectTokenFromBody(data) {
  return data?.token || data?.Token || data?.access_token || data?.data?.token || data?.data?.access_token || null;
}

function detectRedirectUrl(data) {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const u = detectRedirectUrl(item);
      if (u) return u;
    }
    return null;
  }

  return (
    data.Click2Pay ||
    data.short_Click2Pay ||
    data.IframeClick2Pay ||
    data.BillUrl ||
    data.short_BillUrl ||
    data.data?.Click2Pay ||
    data.data?.short_Click2Pay ||
    data.data?.IframeClick2Pay ||
    data.data?.BillUrl ||
    data.data?.short_BillUrl ||
    null
  );
}

function formatDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function isEmailValid(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// -------------------- Resend --------------------
async function sendReceiptEmailResend({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!RECEIPT_FROM_EMAIL) throw new Error("RECEIPT_FROM_EMAIL missing");

  const from =
    RECEIPT_FROM_NAME && RECEIPT_FROM_NAME.trim()
      ? `${RECEIPT_FROM_NAME} <${RECEIPT_FROM_EMAIL}>`
      : RECEIPT_FROM_EMAIL;

  const payload = { from, to, subject, html };

  const r = await axios.post("https://api.resend.com/emails", payload, {
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Resend error (${r.status}): ${stringifySafe(r.data)}`);
  }
  return r.data;
}

function buildReceiptHtml({ orderId, amount, customerName, customerEmail }) {
  const safeName = customerName ? String(customerName) : "Customer";
  const safeEmail = customerEmail ? String(customerEmail) : "";
  const safeAmount = Number(amount || 0);

  return `
  <div style="font-family: Arial, sans-serif; padding:16px; color:#111">
    <h2 style="margin:0 0 8px">Payment Successful ✅</h2>
    <p style="margin:0 0 12px">Hi <b>${safeName}</b>, thanks for your order!</p>
    <div style="border:1px solid #e5e7eb; border-radius:12px; padding:12px; background:#fafafa">
      <p style="margin:0 0 6px"><b>Order ID:</b> ${orderId}</p>
      <p style="margin:0 0 6px"><b>Paid Amount:</b> Rs ${safeAmount.toFixed(0)}</p>
      ${safeEmail ? `<p style="margin:0"><b>Email:</b> ${safeEmail}</p>` : ""}
    </div>
    <p style="margin:12px 0 0; color:#444">If you have any questions, reply to this email.</p>
    <p style="margin:18px 0 0; font-size:12px; color:#777">© ${new Date().getFullYear()} Secrets Discounts</p>
  </div>`;
}

// -------------------- PayPro AUTH --------------------
async function getPayProToken() {
  requireEnvOrThrow();

  const payload = {
    clientid: PAYPRO_CLIENT_ID,
    clientsecret: PAYPRO_CLIENT_SECRET,
    ClientId: PAYPRO_CLIENT_ID,
    ClientSecret: PAYPRO_CLIENT_SECRET,
  };

  const baseCandidates = [
    PAYPRO_BASE_URL,
    PAYPRO_BASE_URL.includes("://www.")
      ? PAYPRO_BASE_URL.replace("://www.", "://")
      : PAYPRO_BASE_URL.replace("://", "://www."),
  ].filter(Boolean);

  const pathCandidates = Array.from(new Set([PAYPRO_AUTH_PATH || "/v2/ppro/auth", "/v2/ppro/auth", "/ppro/auth"]));

  let lastErr = null;

  for (const base of baseCandidates) {
    for (const path of pathCandidates) {
      const authUrl = makeUrl(base, path);

      const r = await axios.post(authUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
        validateStatus: () => true,
      });

      console.log("PayPro AUTH TRY URL:", authUrl);
      console.log("PayPro AUTH status:", r.status);
      console.log("PayPro AUTH content-type:", r.headers?.["content-type"]);
      console.log("PayPro AUTH body preview:", stringifySafe(r.data).slice(0, 200));

      if (isHtmlResponse(r.headers, r.data)) {
        lastErr = `Auth returned HTML on ${authUrl}`;
        continue;
      }
      if (looksLikeInvalidKeys(r.data)) {
        lastErr = `Auth says "InValid Keys" on ${authUrl}`;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        lastErr = `Auth failed (${r.status}) on ${authUrl}: ${stringifySafe(r.data).slice(0, 200)}`;
        continue;
      }

      const token = detectTokenFromHeaders(r.headers) || detectTokenFromBody(r.data);
      if (!token) {
        lastErr = `Auth OK but token missing on ${authUrl}`;
        continue;
      }

      console.log("✅ PayPro AUTH OK:", authUrl);
      return token;
    }
  }

  const err = new Error(lastErr || "Auth failed on all candidates.");
  err.statusCode = 500;
  throw err;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("PayPro backend running."));
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    service: "paypro-backend",
    port: PORT,
    allowedOrigins: FRONTEND_ORIGINS,
    hasResend: Boolean(RESEND_API_KEY),
    fromEmail: RECEIPT_FROM_EMAIL || null,
    firebaseConfigured: Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim()),
  })
);

// GET test for UIS
app.get("/paypro/uis", (req, res) => {
  res.json({ ok: true, message: "UIS is POST callback. GET is only for testing." });
});

// Test email
app.get("/api/test-email", async (req, res) => {
  try {
    const to = String(req.query.to || "").trim() || RECEIPT_FROM_EMAIL;
    if (!isEmailValid(to)) return res.status(400).json({ ok: false, message: "Invalid ?to=email" });

    await sendReceiptEmailResend({
      to,
      subject: "Test Email - Secrets Discounts",
      html: buildReceiptHtml({
        orderId: `TEST-${Date.now()}`,
        amount: 100,
        customerName: "Test Customer",
        customerEmail: to,
      }),
    });

    return res.json({ ok: true, message: "Email sent via Resend" });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
});

// ✅ Initiate PayPro + SAVE REAL ORDER DOC PATH MAPPING
// Frontend MUST send: { orderId, amount, customer, description, appId, uid, orderDocId }
app.post("/api/paypro/initiate", async (req, res) => {
  try {
    requireEnvOrThrow();

    const { orderId, amount, customer, description, appId, uid, orderDocId } = req.body || {};

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId is required" });

    // THIS is the “final” requirement for your real path:
    if (!appId || !uid || !orderDocId) {
      return res.status(400).json({
        ok: false,
        message: "appId, uid, orderDocId are required (for real Firestore order update + receipt)",
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ ok: false, message: "amount must be > 0" });
    }

    const customerEmail = String(customer?.email || "").trim();
    const customerName = String(customer?.fullName || customer?.name || "Customer").trim();
    const customerPhone = String(customer?.phone || "").trim();

    const token = await getPayProToken();

    const now = new Date();
    const due = new Date(now);
    due.setDate(now.getDate() + 1);

    const coPayload = [
      { MerchantId: PAYPRO_MERCHANT_ID },
      {
        OrderNumber: String(orderId),
        OrderAmount: String(Math.round(numericAmount)),
        OrderDueDate: formatDDMMYYYY(due),
        OrderType: "Service",
        IssueDate: formatDDMMYYYY(now),
        OrderExpireAfterSeconds: "0",
        CustomerName: customerName || "Customer",
        CustomerMobile: customerPhone,
        CustomerEmail: customerEmail || "",
        CustomerAddress: String(description || ""),
        ReturnURL: PAYPRO_RETURN_URL,
        CancelURL: PAYPRO_CANCEL_URL,
      },
    ];

    const coUrl = makeUrl(PAYPRO_BASE_URL, PAYPRO_CREATE_ORDER_PATH);

    const r = await axios.post(coUrl, coPayload, {
      headers: { "Content-Type": "application/json", Token: token },
      timeout: 20000,
      validateStatus: () => true,
    });

    console.log("PayPro CO URL:", coUrl);
    console.log("PayPro CO status:", r.status);
    console.log("PayPro CO content-type:", r.headers?.["content-type"]);
    console.log("PayPro CO body preview:", stringifySafe(r.data).slice(0, 700));

    if (isHtmlResponse(r.headers, r.data)) {
      return res.status(500).json({
        ok: false,
        message: "CO returned HTML (wrong route). Check PAYPRO_CREATE_ORDER_PATH / BASE_URL.",
      });
    }
    if (r.status < 200 || r.status >= 300) {
      return res.status(500).json({
        ok: false,
        message: `Initiate error (${r.status}): ${stringifySafe(r.data).slice(0, 500)}`,
        raw: r.data,
      });
    }

    const redirectUrl = detectRedirectUrl(r.data);

    // ✅ FINAL: store exact order doc path mapping for callback
    // /artifacts/${appId}/users/${uid}/orders/${orderDocId}
    try {
      const fs = await initFirebaseAdmin();

      const orderDocPath = `artifacts/${appId}/users/${uid}/orders/${orderDocId}`;

      await fs.collection("paypro_mappings").doc(String(orderId)).set(
        {
          orderId: String(orderId),
          appId: String(appId),
          uid: String(uid),
          orderDocId: String(orderDocId),
          orderDocPath,
          email: customerEmail || "",
          name: customerName || "Customer",
          amount: Math.round(numericAmount),
          redirectUrl: redirectUrl || null,
          status: "initiated",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (e) {
      console.log("⚠️ mapping store failed:", e?.message || e);
      // PayPro still works, but callback receipt/update may fail
    }

    return res.status(200).json({
      ok: true,
      orderId,
      redirectUrl: redirectUrl || null,
      raw: r.data,
    });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

// ✅ PayPro callback (marks paid in REAL order doc + sends receipt)
app.post("/paypro/uis", async (req, res) => {
  try {
    const { username, password, csvinvoiceids } = req.body || {};

    if (!username || !password || !csvinvoiceids) {
      return res.status(400).json([
        { StatusCode: "01", InvoiceID: null, Description: "Invalid Data. Username/password/csvinvoiceids missing" },
      ]);
    }

    if (PAYPRO_CALLBACK_USERNAME && username !== PAYPRO_CALLBACK_USERNAME) {
      return res.status(401).json([{ StatusCode: "01", InvoiceID: null, Description: "Invalid Data. Username or password is invalid" }]);
    }
    if (PAYPRO_CALLBACK_PASSWORD && password !== PAYPRO_CALLBACK_PASSWORD) {
      return res.status(401).json([{ StatusCode: "01", InvoiceID: null, Description: "Invalid Data. Username or password is invalid" }]);
    }

    const ids = String(csvinvoiceids).split(",").map(s => s.trim()).filter(Boolean);

    const fs = await initFirebaseAdmin();

    for (const orderId of ids) {
      let mapping = null;

      try {
        const mapSnap = await fs.collection("paypro_mappings").doc(String(orderId)).get();
        mapping = mapSnap.exists ? (mapSnap.data() || null) : null;
      } catch (e) {
        console.log("⚠️ mapping read failed:", orderId, e?.message || e);
      }

      if (!mapping?.orderDocPath) {
        console.log("⚠️ No mapping found for orderId:", orderId);
        continue;
      }

      // 1) Update REAL order doc
      try {
        await fs.doc(mapping.orderDocPath).set(
          {
            orderStatus: "Paid",
            paymentMethod: "online",
            payment: {
              method: "online",
              gateway: "paypro",
              status: "paid",
              amount: Number(mapping.amount || 0),
              payproOrderId: String(orderId),
              updatedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
            paidAt: new Date().toISOString(),
          },
          { merge: true }
        );

        await fs.collection("paypro_mappings").doc(String(orderId)).set(
          { status: "paid", paidAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { merge: true }
        );
      } catch (e) {
        console.log("⚠️ order doc update failed:", orderId, e?.message || e);
      }

      // 2) Send receipt email (if email exists)
      const email = String(mapping.email || "").trim();
      const name = String(mapping.name || "Customer").trim();
      const amount = Number(mapping.amount || 0) || 0;

      if (isEmailValid(email)) {
        try {
          await sendReceiptEmailResend({
            to: email,
            subject: `Receipt - Order ${orderId} (Paid)`,
            html: buildReceiptHtml({ orderId, amount, customerName: name, customerEmail: email }),
          });
          console.log("✅ Receipt sent:", orderId, "->", email);
        } catch (e) {
          console.log("⚠️ receipt send failed:", orderId, e?.message || e);
        }
      } else {
        console.log("⚠️ No valid email in mapping for receipt:", orderId);
      }
    }

    // PayPro expects array response
    return res.status(200).json(
      ids.map(id => ({
        StatusCode: "00",
        InvoiceID: id,
        Description: "Invoice successfully marked as paid",
      }))
    );
  } catch (e) {
    return res.status(500).json([{ StatusCode: "02", InvoiceID: null, Description: "Service Failure" }]);
  }
});

// CORS error handler
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("CORS blocked")) {
    return res.status(403).json({ ok: false, message: err.message });
  }
  return next(err);
});

app.listen(PORT, () => console.log(`PayPro backend running on port ${PORT}`));
