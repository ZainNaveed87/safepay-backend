// paypro-backend/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();

// ✅ Render sets PORT automatically. Keep fallback for local dev.
const PORT = Number(process.env.PORT || 5050);

// ✅ Allow multiple origins (comma-separated) for local + production
// Example env:
// FRONTEND_ORIGIN=https://secretsdiscounts.com,http://localhost:8080
const FRONTEND_ORIGINS_RAW =
  process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const FRONTEND_ORIGINS = FRONTEND_ORIGINS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.set("trust proxy", 1);

// ---- MIDDLEWARE ----
app.use(
  cors({
    origin: function (origin, cb) {
      // allow server-to-server requests (no Origin), Postman, PayPro etc.
      if (!origin) return cb(null, true);

      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));

// ---- PAYPRO ENV ----
const PAYPRO_BASE_URL = (process.env.PAYPRO_BASE_URL || "").replace(/\/$/, ""); // e.g. https://api.paypro.com.pk
const PAYPRO_CLIENT_ID = (process.env.PAYPRO_CLIENT_ID || "").trim();
const PAYPRO_CLIENT_SECRET = (process.env.PAYPRO_CLIENT_SECRET || "").trim();

const PAYPRO_MERCHANT_ID =
  (process.env.PAYPRO_MERCHANT_ID || process.env.PAYPRO_USERNAME || "").trim();

const PAYPRO_RETURN_URL =
  process.env.PAYPRO_RETURN_URL || "http://localhost:8080/payment/success";
const PAYPRO_CANCEL_URL =
  process.env.PAYPRO_CANCEL_URL || "http://localhost:8080/payment/cancel";

// ✅ PayPro ppro family endpoints
const PAYPRO_AUTH_PATH = (process.env.PAYPRO_AUTH_PATH || "/v2/ppro/auth").trim();
const PAYPRO_CREATE_ORDER_PATH = (process.env.PAYPRO_CREATE_ORDER_PATH || "/v2/ppro/co").trim();

// Callback creds (PayPro -> your API)
const PAYPRO_CALLBACK_USERNAME =
  (process.env.PAYPRO_CALLBACK_USERNAME || process.env.PAYPRO_USERNAME || "").trim();
const PAYPRO_CALLBACK_PASSWORD = (process.env.PAYPRO_CALLBACK_PASSWORD || "").trim();

// ---- RESEND ENV ----
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RECEIPT_FROM_EMAIL = (process.env.RECEIPT_FROM_EMAIL || "").trim(); // e.g. help@secretsdiscounts.com
const RECEIPT_FROM_NAME = (process.env.RECEIPT_FROM_NAME || "Secrets Discounts").trim();

// ---- ROUTES ----
app.get("/", (req, res) => res.send("PayPro backend running."));
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    service: "paypro-backend",
    port: PORT,
    allowedOrigins: FRONTEND_ORIGINS,
    resendConfigured: Boolean(RESEND_API_KEY),
    fromConfigured: Boolean(RECEIPT_FROM_EMAIL),
  })
);

// ---- HELPERS ----
function requirePayProEnvOrThrow() {
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

function requireResendEnvOrThrow() {
  const missing = [];
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!RECEIPT_FROM_EMAIL) missing.push("RECEIPT_FROM_EMAIL");
  if (missing.length) {
    const err = new Error(`Missing email env: ${missing.join(", ")}`);
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

  const direct =
    headers["token"] ||
    headers["Token"] ||
    headers["TOKEN"] ||
    headers["x-token"] ||
    headers["X-Token"] ||
    headers["x-auth-token"] ||
    headers["X-Auth-Token"] ||
    headers["access-token"] ||
    headers["Access-Token"] ||
    null;

  if (direct) return direct;

  for (const [k, v] of Object.entries(headers)) {
    const key = String(k || "").toLowerCase();
    if (
      key === "token" ||
      key === "x-token" ||
      key === "x-auth-token" ||
      key === "access-token"
    ) {
      return v;
    }
  }
  return null;
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

// ---- RESEND EMAIL (HTTP API) ----
async function sendEmailResend({ to, subject, html }) {
  requireResendEnvOrThrow();

  const payload = {
    from: `${RECEIPT_FROM_NAME} <${RECEIPT_FROM_EMAIL}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };

  const r = await axios.post("https://api.resend.com/emails", payload, {
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    const msg = `Resend error (${r.status}): ${stringifySafe(r.data).slice(0, 800)}`;
    const err = new Error(msg);
    err.statusCode = 500;
    throw err;
  }

  return r.data;
}

// ✅ Test email route
app.get("/api/test-email", async (req, res) => {
  try {
    await sendEmailResend({
      to: RECEIPT_FROM_EMAIL,
      subject: "Resend Test ✅",
      html: "<h2>Resend email working 🎉</h2><p>This email was sent from Render via Resend API.</p>",
    });

    return res.json({ ok: true, message: "Email sent via Resend" });
  } catch (e) {
    console.error("test-email error:", e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || "Email test failed" });
  }
});

// ✅ Send receipt endpoint (frontend/callback dono use kar sakte ho)
app.post("/api/send-receipt", async (req, res) => {
  try {
    const { customerEmail, customerName, orderId, amount, paymentMethod, items } = req.body || {};

    if (!customerEmail || !orderId) {
      return res.status(400).json({ ok: false, message: "customerEmail & orderId required" });
    }

    const safeName = customerName || "Customer";
    const safeMethod = paymentMethod || "Online";
    const safeAmount = amount ?? "";

    const itemsHtml =
      Array.isArray(items) && items.length
        ? `<ul>${items
            .map(
              (i) =>
                `<li>${i?.name || "Item"} × ${i?.qty || 1} — Rs ${i?.price ?? ""}</li>`
            )
            .join("")}</ul>`
        : `<p>(Items not provided)</p>`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2 style="margin:0 0 8px;">Thanks for your order, ${safeName}!</h2>
        <p style="margin:0 0 12px;">Your receipt:</p>

        <table cellpadding="6" style="border-collapse: collapse;">
          <tr><td><b>Order ID</b></td><td>${orderId}</td></tr>
          <tr><td><b>Amount</b></td><td>Rs ${safeAmount}</td></tr>
          <tr><td><b>Payment</b></td><td>${safeMethod}</td></tr>
        </table>

        <hr style="margin:16px 0;" />
        <h3 style="margin:0 0 8px;">Order Items</h3>
        ${itemsHtml}

        <p style="margin-top:16px;">— ${RECEIPT_FROM_NAME}</p>
      </div>
    `;

    await sendEmailResend({
      to: customerEmail,
      subject: `Order Receipt - ${orderId}`,
      html,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("send-receipt error:", e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to send receipt" });
  }
});

// ---- PAYPRO AUTH (LIVE candidates) ----
async function getPayProToken() {
  requirePayProEnvOrThrow();

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
      console.log("PayPro AUTH body preview:", stringifySafe(r.data).slice(0, 250));

      if (isHtmlResponse(r.headers, r.data)) {
        lastErr = `Auth returned HTML on ${authUrl}`;
        continue;
      }

      if (looksLikeInvalidKeys(r.data)) {
        lastErr = `Auth says "InValid Keys" on ${authUrl}.`;
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

  const err = new Error(
    lastErr ||
      "Auth failed on all candidates. Check PAYPRO_BASE_URL and confirm LIVE auth endpoint from PayPro."
  );
  err.statusCode = 500;
  throw err;
}

// ---- INITIATE (Create Order / CO) ----
app.post("/api/paypro/initiate", async (req, res) => {
  try {
    requirePayProEnvOrThrow();

    const { orderId, amount, customer, description } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId is required" });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ ok: false, message: "amount must be > 0" });
    }

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
        CustomerName: customer?.fullName || customer?.name || "Customer",
        CustomerMobile: customer?.phone || "",
        CustomerEmail: customer?.email || "",
        CustomerAddress: customer?.address || description || "",
        ReturnURL: PAYPRO_RETURN_URL,
        CancelURL: PAYPRO_CANCEL_URL,
      },
    ];

    const coUrl = makeUrl(PAYPRO_BASE_URL, PAYPRO_CREATE_ORDER_PATH);

    const r = await axios.post(coUrl, coPayload, {
      headers: {
        "Content-Type": "application/json",
        Token: token,
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    console.log("PayPro CO URL:", coUrl);
    console.log("PayPro CO status:", r.status);
    console.log("PayPro CO content-type:", r.headers?.["content-type"]);
    console.log("PayPro CO body preview:", stringifySafe(r.data).slice(0, 900));

    if (isHtmlResponse(r.headers, r.data)) {
      return res.status(500).json({
        ok: false,
        message: "CO returned HTML (wrong route). Check PAYPRO_CREATE_ORDER_PATH / BASE_URL.",
        raw: String(r.data).slice(0, 500),
      });
    }

    if (r.status < 200 || r.status >= 300) {
      return res.status(500).json({
        ok: false,
        message: `Initiate error (${r.status}): ${stringifySafe(r.data).slice(0, 800)}`,
        raw: r.data,
      });
    }

    const redirectUrl = detectRedirectUrl(r.data);

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

// ---- CALLBACK (PayPro -> Your API) ----
// ✅ Put THIS URL in PayPro panel UIS/Callback:
// https://YOUR-RENDER-DOMAIN/paypro/uis
app.post("/paypro/uis", async (req, res) => {
  try {
    const { username, password, csvinvoiceids } = req.body || {};

    if (!username || !password || !csvinvoiceids) {
      return res.status(400).json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username/password/csvinvoiceids missing",
        },
      ]);
    }

    // verify callback creds (recommended)
    if (PAYPRO_CALLBACK_USERNAME && username !== PAYPRO_CALLBACK_USERNAME) {
      return res.status(401).json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username or password is invalid",
        },
      ]);
    }
    if (PAYPRO_CALLBACK_PASSWORD && password !== PAYPRO_CALLBACK_PASSWORD) {
      return res.status(401).json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username or password is invalid",
        },
      ]);
    }

    const ids = String(csvinvoiceids)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // ✅ OPTIONAL: If you store orderId->customerEmail somewhere,
    // you can lookup and send receipt here using sendEmailResend().
    // For now, we just acknowledge payment.

    const response = ids.map((id) => ({
      StatusCode: "00",
      InvoiceID: id,
      Description: "Invoice successfully marked as paid",
    }));

    return res.status(200).json(response);
  } catch {
    return res.status(500).json([
      { StatusCode: "02", InvoiceID: null, Description: "Service Failure" },
    ]);
  }
});

// ✅ Nice: show if CORS error happens
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("CORS blocked")) {
    return res.status(403).json({ ok: false, message: err.message });
  }
  return next(err);
});

app.listen(PORT, () => console.log(`PayPro backend running on port ${PORT}`));
