// paypro-backend/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";

// -------------------- Firebase Admin (optional but required for mapping + order status update) --------------------
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

// Allow multiple origins separated by comma
const FRONTEND_ORIGINS_RAW =
  process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const FRONTEND_ORIGINS = FRONTEND_ORIGINS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- PayPro ENV ----
const PAYPRO_BASE_URL = (process.env.PAYPRO_BASE_URL || "").replace(/\/$/, "");
const PAYPRO_CLIENT_ID = (process.env.PAYPRO_CLIENT_ID || "").trim();
const PAYPRO_CLIENT_SECRET = (process.env.PAYPRO_CLIENT_SECRET || "").trim();

const PAYPRO_MERCHANT_ID =
  (process.env.PAYPRO_MERCHANT_ID || process.env.PAYPRO_USERNAME || "").trim();

const PAYPRO_RETURN_URL = (
  process.env.PAYPRO_RETURN_URL || "http://localhost:8080/payment/success"
).trim();
const PAYPRO_CANCEL_URL = (
  process.env.PAYPRO_CANCEL_URL || "http://localhost:8080/payment/cancel"
).trim();

const PAYPRO_AUTH_PATH = (process.env.PAYPRO_AUTH_PATH || "/v2/ppro/auth").trim();
const PAYPRO_CREATE_ORDER_PATH = (
  process.env.PAYPRO_CREATE_ORDER_PATH || "/v2/ppro/co"
).trim();

// ✅ GGOS path (order status by cpayId/PayProId) — used for FINAL reliable verification
const PAYPRO_GGOS_PATH = (process.env.PAYPRO_GGOS_PATH || "/v2/ppro/ggos").trim();

// PayPro UIS callback creds (optional)
const PAYPRO_CALLBACK_USERNAME = (
  process.env.PAYPRO_CALLBACK_USERNAME || process.env.PAYPRO_USERNAME || ""
).trim();
const PAYPRO_CALLBACK_PASSWORD = (process.env.PAYPRO_CALLBACK_PASSWORD || "").trim();

// -------------------- Middleware --------------------
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // allow curl/postman/server-to-server
      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
  })
);

// PayPro UIS kabhi kabhi urlencoded bhejta hai
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

// ✅ PayPro "Returning Back" FIX:
// Click2Pay URL me callback_url add kar do
function appendCallbackUrl(click2payUrl, callbackUrl) {
  try {
    const u = new URL(click2payUrl);
    u.searchParams.set("callback_url", callbackUrl);
    return u.toString();
  } catch {
    const sep = String(click2payUrl).includes("?") ? "&" : "?";
    return `${click2payUrl}${sep}callback_url=${encodeURIComponent(callbackUrl)}`;
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

// -------------------- PayPro CO Response parsing --------------------
// Your CO response is usually like:
// [ {"Status":"00"}, { ... "PayProId":"2598...", "Click2Pay":"..." } ]
function parseCO(data) {
  const d = data;

  if (Array.isArray(d)) {
    const statusObj =
      d.find((x) => x && typeof x === "object" && "Status" in x) || {};
    const detailsObj =
      d.find(
        (x) => x && typeof x === "object" && ("PayProId" in x || "Click2Pay" in x)
      ) || {};
    return { statusObj, detailsObj };
  }

  if (d && typeof d === "object") {
    const statusObj = d.Status ? { Status: d.Status } : {};
    return { statusObj, detailsObj: d };
  }

  return { statusObj: {}, detailsObj: {} };
}

// -------------------- Helper: mark order paid in Firestore --------------------
async function markOrderPaidByMapping(fs, mapping, { payproId, orderId, payproStatus }) {
  if (!mapping?.orderDocPath) return { ok: false, message: "mapping.orderDocPath missing" };

  await fs.doc(mapping.orderDocPath).set(
    {
      orderStatus: "Paid",
      paymentMethod: "online",
      payment: {
        method: "online",
        gateway: "paypro",
        status: "paid",
        amount: Number(mapping.amount || 0),
        payproId: payproId ? String(payproId) : null,
        payproOrderId: orderId ? String(orderId) : null,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
    },
    { merge: true }
  );

  // update mapping docs
  if (payproId) {
    await fs
      .collection("paypro_mappings_by_payproid")
      .doc(String(payproId))
      .set(
        {
          status: "paid",
          payproStatus: payproStatus || null,
          paidAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastVerifyAt: new Date().toISOString(),
        },
        { merge: true }
      );
  }

  if (mapping.orderId) {
    await fs
      .collection("paypro_mappings")
      .doc(String(mapping.orderId))
      .set(
        {
          status: "paid",
          payproStatus: payproStatus || null,
          payproId: payproId ? String(payproId) : null,
          paidAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastVerifyAt: new Date().toISOString(),
        },
        { merge: true }
      );
  }

  return { ok: true };
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
    ggosPath: PAYPRO_GGOS_PATH,
  })
);

// GET test for UIS
app.get("/paypro/uis", (req, res) => {
  res.json({ ok: true, message: "UIS is POST callback. GET is only for testing." });
});

// ✅ FINAL: Verify order status by PayProId (cpayId) via GGOS
// Use this on success page / orders page auto-check
app.get("/api/paypro/status", async (req, res) => {
  try {
    requireEnvOrThrow();

    const cpayId = String(req.query.cpayId || req.query.payproId || "").trim();
    if (!cpayId) {
      return res.status(400).json({ ok: false, message: "cpayId (PayProId) is required" });
    }

    const token = await getPayProToken();
    const ggosUrl = makeUrl(PAYPRO_BASE_URL, PAYPRO_GGOS_PATH);

    // ✅ GGOS payload (as per PayPro v2 docs examples)
    const payload = [
      { MerchantId: PAYPRO_MERCHANT_ID },
      { userName: PAYPRO_MERCHANT_ID, cpayId: String(cpayId) },
    ];

    const r = await axios.post(ggosUrl, payload, {
      headers: { "Content-Type": "application/json", Token: token },
      timeout: 20000,
      validateStatus: () => true,
    });

    console.log("PayPro GGOS URL:", ggosUrl);
    console.log("PayPro GGOS status:", r.status);
    console.log("PayPro GGOS body preview:", stringifySafe(r.data).slice(0, 600));

    if (isHtmlResponse(r.headers, r.data)) {
      return res.status(500).json({
        ok: false,
        message: "GGOS returned HTML (wrong route). Check PAYPRO_GGOS_PATH / BASE_URL.",
        raw: r.data,
      });
    }
    if (r.status < 200 || r.status >= 300) {
      return res.status(500).json({
        ok: false,
        message: `GGOS error (${r.status}): ${stringifySafe(r.data).slice(0, 300)}`,
        raw: r.data,
      });
    }

    const raw = r.data;
    const txt = typeof raw === "string" ? raw : JSON.stringify(raw);
    const lower = txt.toLowerCase();

    // ✅ robust "paid" detect (PayPro formats differ)
    const paid =
      lower.includes('"status":"00"') ||
      lower.includes('"statuscode":"00"') ||
      lower.includes(" paid") ||
      lower.includes('"paid"') ||
      lower.includes("success");

    // ✅ If paid -> update Firestore order using mapping by payproId
    let updated = false;
    try {
      if (paid) {
        const fs = await initFirebaseAdmin();

        let mapping = null;
        const snap = await fs.collection("paypro_mappings_by_payproid").doc(String(cpayId)).get();
        mapping = snap.exists ? (snap.data() || null) : null;

        if (!mapping) {
          const alt = await fs.collection("paypro_mappings").doc(String(cpayId)).get();
          mapping = alt.exists ? (alt.data() || null) : null;
        }

        if (mapping?.orderDocPath) {
          await markOrderPaidByMapping(fs, mapping, {
            payproId: cpayId,
            orderId: mapping.orderId || null,
            payproStatus: "paid_via_ggos",
          });
          updated = true;
        }
      }
    } catch (e) {
      console.log("⚠️ GGOS paid -> firestore update failed:", e?.message || e);
    }

    return res.status(200).json({ ok: true, cpayId, paid, updated, raw });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

// ✅ Initiate PayPro + SAVE REAL ORDER DOC PATH MAPPING
// ✅ save mapping by PayProId AND by orderId
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

    // ✅ attach order id to return/cancel so pages open with oid
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

    // ✅ Extract PayProId (critical)
    const { statusObj, detailsObj } = parseCO(r.data);
    const payproId = detailsObj?.PayProId || detailsObj?.PayProID || null;
    const status = String(statusObj?.Status || detailsObj?.Status || "");

    // ✅ redirect URL (Click2Pay)
    let redirectUrl = detectRedirectUrl(r.data);

    // ✅ MOST IMPORTANT: add callback_url into Click2Pay (Returning Back)
    if (redirectUrl) {
      redirectUrl = appendCallbackUrl(redirectUrl, returnUrl);
    }

    // ✅ store mapping in Firestore
    try {
      const fs = await initFirebaseAdmin();
      const orderDocPath = `artifacts/${appId}/users/${uid}/orders/${orderDocId}`;

      const mappingDoc = {
        orderId: String(orderId),
        payproId: payproId ? String(payproId) : null,
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
        payproStatus: status || null,
        returnUrl,
        cancelUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1) by orderId
      await fs.collection("paypro_mappings").doc(String(orderId)).set(mappingDoc, { merge: true });

      // 2) by PayProId
      if (payproId) {
        await fs
          .collection("paypro_mappings_by_payproid")
          .doc(String(payproId))
          .set(mappingDoc, { merge: true });
      }
    } catch (e) {
      console.log("⚠️ mapping store failed:", e?.message || e);
    }

    return res.status(200).json({
      ok: true,
      orderId,
      payproId: payproId || null,
      status: status || null,
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

// ✅ PayPro UIS callback (still supported, but GGOS is your FINAL reliable verification)
// ✅ handle BOTH styles:
// A) old style: {username,password,csvinvoiceids}
// B) new style: JSON array with Status + PayProId
app.post("/paypro/uis", async (req, res) => {
  try {
    console.log("✅ PayPro UIS HIT");
    console.log("Headers content-type:", req.headers?.["content-type"]);
    console.log("Body:", req.body);

    const fs = await initFirebaseAdmin();

    // ---------- Style B (JSON array/object) ----------
    const body = req.body;

    const isJsonArrayStyle = Array.isArray(body);
    const isJsonObjectStyle = body && typeof body === "object" && !("csvinvoiceids" in body);

    if (isJsonArrayStyle || isJsonObjectStyle) {
      const { statusObj, detailsObj } = parseCO(body);

      const payproId = detailsObj?.PayProId || detailsObj?.PayProID || null;
      const status = String(statusObj?.Status || detailsObj?.Status || "");

      if (!payproId) {
        return res.status(400).json({ ok: false, message: "Missing PayProId in UIS callback" });
      }

      // find mapping by payproId
      let mapping = null;
      try {
        const mapSnap = await fs
          .collection("paypro_mappings_by_payproid")
          .doc(String(payproId))
          .get();
        mapping = mapSnap.exists ? mapSnap.data() || null : null;

        if (!mapping) {
          const alt = await fs.collection("paypro_mappings").doc(String(payproId)).get();
          mapping = alt.exists ? alt.data() || null : null;
        }
      } catch (e) {
        console.log("⚠️ mapping read failed by payproId:", payproId, e?.message || e);
      }

      if (!mapping?.orderDocPath) {
        console.log("⚠️ No mapping found for payproId:", payproId);
        return res.status(200).json({ ok: true, note: "mapping not found", payproId, status });
      }

      const isSuccess =
        status === "00" || status.toLowerCase() === "paid" || status.toLowerCase() === "success";

      if (isSuccess) {
        try {
          await markOrderPaidByMapping(fs, mapping, {
            payproId: String(payproId),
            orderId: mapping.orderId || null,
            payproStatus: status,
          });

          // mark callback time
          await fs
            .collection("paypro_mappings_by_payproid")
            .doc(String(payproId))
            .set(
              {
                lastCallbackAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
        } catch (e) {
          console.log("⚠️ order doc update failed:", payproId, e?.message || e);
        }
      }

      return res.status(200).json({ ok: true, payproId, status });
    }

    // ---------- Style A (urlencoded) ----------
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

    // enforce creds only if set in ENV
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

      try {
        await markOrderPaidByMapping(fs, mapping, {
          payproId: mapping.payproId || null,
          orderId: String(orderId),
          payproStatus: "paid_via_uis",
        });

        await fs.collection("paypro_mappings").doc(String(orderId)).set(
          {
            lastCallbackAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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
