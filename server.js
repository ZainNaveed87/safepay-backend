// paypro-backend/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";

// -------------------- OPTIONAL: Firebase Admin (still optional for order status update) --------------------
let admin = null;
let firestore = null;

async function initFirebaseAdmin() {
  if (firestore) return firestore;

  const svcJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!svcJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");

  const mod = await import("firebase-admin");
  admin = mod.default || mod;

  if (!admin.apps?.length) {
    const creds = JSON.parse(svcJson);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }

  firestore = admin.firestore();
  return firestore;
}

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 5050);

const FRONTEND_ORIGINS_RAW = process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const FRONTEND_ORIGINS = FRONTEND_ORIGINS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- PayPro ENV ----
const PAYPRO_BASE_URL = (process.env.PAYPRO_BASE_URL || "").replace(/\/$/, "");
const PAYPRO_CLIENT_ID = (process.env.PAYPRO_CLIENT_ID || "").trim();
const PAYPRO_CLIENT_SECRET = (process.env.PAYPRO_CLIENT_SECRET || "").trim();

const PAYPRO_MERCHANT_ID =
  (process.env.PAYPRO_MERCHANT_ID || process.env.PAYPRO_USERNAME || "").trim();

const PAYPRO_RETURN_URL =
  (process.env.PAYPRO_RETURN_URL || "http://localhost:8080/payment/success").trim();
const PAYPRO_CANCEL_URL =
  (process.env.PAYPRO_CANCEL_URL || "http://localhost:8080/payment/cancel").trim();

const PAYPRO_AUTH_PATH = (process.env.PAYPRO_AUTH_PATH || "/v2/ppro/auth").trim();
const PAYPRO_CREATE_ORDER_PATH = (process.env.PAYPRO_CREATE_ORDER_PATH || "/v2/ppro/co").trim();

// PayPro callback creds (optional)
const PAYPRO_CALLBACK_USERNAME =
  (process.env.PAYPRO_CALLBACK_USERNAME || process.env.PAYPRO_USERNAME || "").trim();
const PAYPRO_CALLBACK_PASSWORD = (process.env.PAYPRO_CALLBACK_PASSWORD || "").trim();

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

// PayPro callback kabhi kabhi urlencoded bhejta hai
app.use(express.urlencoded({ extended: true }));
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
  return (
    data?.token ||
    data?.Token ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.access_token ||
    null
  );
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

function safeRoundAmount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x);
}

function makePayproAck(ids, ok = true, descOk = "Invoice successfully marked as paid") {
  return (ids || []).map((id) => ({
    StatusCode: ok ? "00" : "01",
    InvoiceID: id ?? null,
    Description: ok ? descOk : "Invalid Data. Username or password is invalid",
  }));
}

// append order id to urls (so you can show it on success/cancel page)
function withOrderId(url, orderId) {
  try {
    const u = new URL(url);
    u.searchParams.set("oid", String(orderId));
    return u.toString();
  } catch {
    const sep = String(url).includes("?") ? "&" : "?";
    return `${url}${sep}oid=${encodeURIComponent(String(orderId))}`;
  }
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

  const pathCandidates = Array.from(
    new Set([PAYPRO_AUTH_PATH || "/v2/ppro/auth", "/v2/ppro/auth", "/ppro/auth"])
  );

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
    firebaseConfigured: Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim()),
    returnUrl: PAYPRO_RETURN_URL,
    cancelUrl: PAYPRO_CANCEL_URL,
    emailReceiptEnabled: false,
    whatsappEnabled: false,
  })
);

// GET test for UIS
app.get("/paypro/uis", (req, res) => {
  res.json({ ok: true, message: "UIS is POST callback. GET is only for testing." });
});

// ✅ Initiate PayPro + SAVE REAL ORDER DOC PATH MAPPING
app.post("/api/paypro/initiate", async (req, res) => {
  try {
    requireEnvOrThrow();

    const { orderId, amount, customer, description, appId, uid, orderDocId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, message: "orderId is required" });

    if (!appId || !uid || !orderDocId) {
      return res.status(400).json({
        ok: false,
        message: "appId, uid, orderDocId are required (for Firestore mapping)",
      });
    }

    const numericAmount = safeRoundAmount(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ ok: false, message: "amount must be > 0" });
    }

    const customerEmail = String(customer?.email || "").trim();
    const customerName = String(customer?.fullName || customer?.name || "Customer").trim();
    const customerPhone = String(customer?.phone || "").trim();

    const token = await getPayProToken();

    const now = new Date();
    const due = new Date(now);
    due.setDate(now.getDate() + 1);

    // ✅ IMPORTANT: attach order id to return/cancel so pages open with oid
    const returnUrl = withOrderId(PAYPRO_RETURN_URL, orderId);
    const cancelUrl = withOrderId(PAYPRO_CANCEL_URL, orderId);

    // ✅ IMPORTANT: Also set BillMaster Ecommerce_return_url to avoid "empty" in response
    const coPayload = [
      { MerchantId: PAYPRO_MERCHANT_ID },
      {
        OrderNumber: String(orderId),
        OrderAmount: String(numericAmount),
        OrderDueDate: formatDDMMYYYY(due),
        OrderType: "Service",
        IssueDate: formatDDMMYYYY(now),
        OrderExpireAfterSeconds: "0",
        CustomerName: customerName || "Customer",
        CustomerMobile: customerPhone,
        CustomerEmail: customerEmail || "",
        CustomerAddress: String(description || ""),

        // Normal fields:
        ReturnURL: returnUrl,
        CancelURL: cancelUrl,

        // Force fields (PayPro shows these in BillMaster):
        BillMaster: [
          { FieldName: "Ecommerce_return_url", FieldValue: returnUrl },
          { FieldName: "Ecommerce_cancel_url", FieldValue: cancelUrl },
        ],
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

    // mapping store (optional but recommended)
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
          phone: customerPhone || "",
          amount: numericAmount,
          redirectUrl: redirectUrl || null,
          status: "initiated",
          returnUrl,
          cancelUrl,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (e) {
      console.log("⚠️ mapping store failed:", e?.message || e);
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

// ✅ PayPro callback (NO EMAIL RECEIPT NOW)
// NOTE: server-to-server only
app.post("/paypro/uis", async (req, res) => {
  try {
    console.log("✅ PayPro UIS HIT");
    console.log("Body:", req.body);

    const username = req.body?.username;
    const password = req.body?.password;
    const csvinvoiceids = req.body?.csvinvoiceids;

    if (!username || !password || !csvinvoiceids) {
      return res.status(400).json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username/password/csvinvoiceids missing",
        },
      ]);
    }

    // If you set callback creds, then enforce. If not set in ENV, skip enforcement.
    if (PAYPRO_CALLBACK_USERNAME && String(username) !== PAYPRO_CALLBACK_USERNAME) {
      return res.status(401).json(makePayproAck([null], false));
    }
    if (PAYPRO_CALLBACK_PASSWORD && String(password) !== PAYPRO_CALLBACK_PASSWORD) {
      return res.status(401).json(makePayproAck([null], false));
    }

    const ids = String(csvinvoiceids)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const fs = await initFirebaseAdmin();

    for (const orderId of ids) {
      let mapping = null;

      try {
        const mapSnap = await fs.collection("paypro_mappings").doc(String(orderId)).get();
        mapping = mapSnap.exists ? mapSnap.data() || null : null;
      } catch (e) {
        console.log("⚠️ mapping read failed:", orderId, e?.message || e);
      }

      if (!mapping?.orderDocPath) {
        console.log("⚠️ No mapping found for orderId:", orderId);
        continue;
      }

      // Update REAL order doc as PAID
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
          {
            status: "paid",
            paidAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastCallbackAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (e) {
        console.log("⚠️ order doc update failed:", orderId, e?.message || e);
      }
    }

    // PayPro expects array response
    return res.status(200).json(makePayproAck(ids, true, "Invoice successfully marked as paid"));
  } catch (e) {
    console.log("❌ UIS ERROR:", e?.message || e);
    return res
      .status(500)
      .json([{ StatusCode: "02", InvoiceID: null, Description: "Service Failure" }]);
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
