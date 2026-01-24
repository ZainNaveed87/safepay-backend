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

const FRONTEND_ORIGINS_RAW =
  process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const FRONTEND_ORIGINS = FRONTEND_ORIGINS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- PayPro ENV ----
const PAYPRO_BASE_URL = (process.env.PAYPRO_BASE_URL || "").replace(/\/$/, "");
const PAYPRO_CLIENT_ID = (process.env.PAYPRO_CLIENT_ID || "").trim();
const PAYPRO_CLIENT_SECRET = (process.env.PAYPRO_CLIENT_SECRET || "").trim();

const PAYPRO_MERCHANT_ID = (
  process.env.PAYPRO_MERCHANT_ID ||
  process.env.PAYPRO_USERNAME ||
  ""
).trim();

const PAYPRO_RETURN_URL =
  process.env.PAYPRO_RETURN_URL ||
  "http://localhost:8080/payment/success";
const PAYPRO_CANCEL_URL =
  process.env.PAYPRO_CANCEL_URL ||
  "http://localhost:8080/payment/cancel";

const PAYPRO_AUTH_PATH = (process.env.PAYPRO_AUTH_PATH || "/v2/ppro/auth").trim();
const PAYPRO_CREATE_ORDER_PATH = (process.env.PAYPRO_CREATE_ORDER_PATH || "/v2/ppro/co").trim();

// PayPro callback creds
const PAYPRO_CALLBACK_USERNAME = (
  process.env.PAYPRO_CALLBACK_USERNAME ||
  process.env.PAYPRO_USERNAME ||
  ""
).trim();
const PAYPRO_CALLBACK_PASSWORD = (process.env.PAYPRO_CALLBACK_PASSWORD || "").trim();

// ---- Resend ENV ----
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RECEIPT_FROM_EMAIL = (process.env.RECEIPT_FROM_EMAIL || "").trim();
const RECEIPT_FROM_NAME = (process.env.RECEIPT_FROM_NAME || "Secrets Discounts").trim();

// ✅ Logo / Brand
const RECEIPT_LOGO_URL = (process.env.RECEIPT_LOGO_URL || "").trim(); // put your logo url here
const RECEIPT_BRAND_COLOR = (process.env.RECEIPT_BRAND_COLOR || "#2563eb").trim(); // default blue

// Optional deliverability helpers
const RECEIPT_REPLY_TO = (process.env.RECEIPT_REPLY_TO || "").trim(); // e.g. support@yourdomain.com
const RECEIPT_BCC = (process.env.RECEIPT_BCC || "").trim(); // e.g. your accounting email

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

// IMPORTANT: PayPro callback kabhi kabhi urlencoded bhejta hai
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

function isEmailValid(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
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

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return x.toFixed(0);
}

function normalizeItems(items) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .map((it) => ({
      name: it?.name ?? it?.title ?? "",
      image: it?.image ?? it?.img ?? "",
      price: Number(it?.price ?? 0) || 0,
      quantity: Number(it?.quantity ?? 1) || 1,
      variant: it?.variant ?? null,
    }))
    .filter((x) => x.name || x.image);
}

function computeTotalsFromOrder(order) {
  // Prefer stored totals (from your checkout)
  const subtotal = Number(order?.subtotal ?? 0) || 0;
  const shipping = Number(order?.shipping?.fee ?? order?.shippingFee ?? 0) || 0;
  const tax = Number(order?.tax ?? 0) || 0;
  const couponDiscount = Number(order?.couponDiscount ?? 0) || 0;
  const coinsDiscount = Number(order?.coinsDiscount ?? order?.coinsApplied ?? 0) || 0;
  const totalAmount = Number(order?.totalAmount ?? order?.payment?.amount ?? 0) || 0;

  // If subtotal missing, compute from items
  const items = normalizeItems(order?.items);
  const computedSubtotal =
    subtotal > 0 ? subtotal : items.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0);

  // If totalAmount missing, compute
  const computedTotal =
    totalAmount > 0
      ? totalAmount
      : computedSubtotal + shipping + tax - couponDiscount - coinsDiscount;

  return {
    subtotal: computedSubtotal,
    shipping,
    tax,
    couponDiscount,
    coinsDiscount,
    total: computedTotal,
  };
}

// -------------------- Resend --------------------
async function sendReceiptEmailResend({ to, subject, html, text }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!RECEIPT_FROM_EMAIL) throw new Error("RECEIPT_FROM_EMAIL missing");

  const from =
    RECEIPT_FROM_NAME && RECEIPT_FROM_NAME.trim()
      ? `${RECEIPT_FROM_NAME} <${RECEIPT_FROM_EMAIL}>`
      : RECEIPT_FROM_EMAIL;

  const payload = {
    from,
    to,
    subject,
    html,
    text: text || undefined,
    reply_to: RECEIPT_REPLY_TO || undefined,
    bcc: RECEIPT_BCC || undefined,
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
    throw new Error(`Resend error (${r.status}): ${stringifySafe(r.data)}`);
  }
  return r.data;
}

function buildReceiptText({ orderId, customerName, total }) {
  return `Payment Successful
Order ID: ${orderId}
Customer: ${customerName}
Total Paid: Rs ${money(total)}
Thank you for shopping with Secrets Discounts.`;
}

function buildReceiptHtmlFromOrder({
  orderId,
  paidAmount,
  orderDoc,
  logoUrl,
}) {
  const customer = orderDoc?.customer || {};
  const name = escapeHtml(customer?.fullName || customer?.name || "Customer");
  const email = escapeHtml(customer?.email || "");
  const phone = escapeHtml(customer?.phone || "");
  const address = escapeHtml(customer?.address || "");
  const city = escapeHtml(customer?.city || "");
  const state = escapeHtml(customer?.state || "");
  const zip = escapeHtml(customer?.zipCode || "");
  const country = escapeHtml(customer?.country || "Pakistan");

  const createdAt =
    orderDoc?.createdAt || orderDoc?.timestamp || orderDoc?.paidAt || null;

  const items = normalizeItems(orderDoc?.items);
  const totals = computeTotalsFromOrder(orderDoc);

  // prefer paidAmount from mapping if provided
  const totalPaid = Number(paidAmount ?? totals.total ?? 0) || 0;

  const brand = RECEIPT_BRAND_COLOR || "#2563eb";
  const safeLogo = logoUrl ? escapeHtml(logoUrl) : "";

  const orderStatus = escapeHtml(orderDoc?.orderStatus || "Paid");
  const paymentGateway = escapeHtml(orderDoc?.payment?.gateway || "PayPro");

  const itemsRows =
    items.length > 0
      ? items
          .map((it) => {
            const title = escapeHtml(it.name || "");
            const qty = Number(it.quantity || 1) || 1;
            const price = Number(it.price || 0) || 0;
            const line = price * qty;

            const img = (it.image || "").trim();
            const imgCell = img
              ? `<img src="${escapeHtml(img)}" width="56" height="56" alt="${title}" style="display:block;border-radius:10px;object-fit:cover;border:1px solid #e5e7eb;background:#fff;" />`
              : `<div style="width:56px;height:56px;border-radius:10px;border:1px solid #e5e7eb;background:#f3f4f6;"></div>`;

            // variant badges (simple)
            let variantHtml = "";
            if (it.variant && typeof it.variant === "object") {
              const pairs = Object.entries(it.variant)
                .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
                .slice(0, 4)
                .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`);
              if (pairs.length) {
                variantHtml = `<div style="margin-top:4px;color:#6b7280;font-size:12px;">${pairs.join(" • ")}</div>`;
              }
            }

            return `
              <tr>
                <td style="padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;">
                  ${imgCell}
                </td>
                <td style="padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;">
                  <div style="font-weight:600;color:#111827;font-size:14px;line-height:1.25;">${title}</div>
                  ${variantHtml}
                </td>
                <td style="padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;text-align:center;color:#111827;font-size:13px;">
                  ${qty}
                </td>
                <td style="padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;text-align:right;color:#111827;font-size:13px;">
                  Rs ${money(price)}
                </td>
                <td style="padding:12px 10px;border-bottom:1px solid #eef2f7;vertical-align:top;text-align:right;color:#111827;font-size:13px;font-weight:600;">
                  Rs ${money(line)}
                </td>
              </tr>
            `;
          })
          .join("")
      : `
        <tr>
          <td colspan="5" style="padding:14px;color:#6b7280;font-size:13px;border-bottom:1px solid #eef2f7;">
            No items found in this order.
          </td>
        </tr>
      `;

  // totals rows
  const showDiscount = (Number(totals.couponDiscount || 0) + Number(totals.coinsDiscount || 0)) > 0;

  return `
  <div style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f6f7fb;padding:0;margin:0;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="padding:18px 20px;background:${brand};color:#fff;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="vertical-align:middle;">
                      ${safeLogo ? `<img src="${safeLogo}" alt="Logo" height="34" style="display:block;max-height:34px;" />` : `<div style="font-weight:800;font-size:18px;">${escapeHtml(RECEIPT_FROM_NAME)}</div>`}
                      <div style="opacity:0.95;font-size:12px;margin-top:4px;">Official Payment Receipt</div>
                    </td>
                    <td style="vertical-align:middle;text-align:right;">
                      <div style="font-size:14px;font-weight:700;">Payment Successful ✅</div>
                      <div style="opacity:0.95;font-size:12px;margin-top:4px;">Order: <span style="font-weight:700;">${escapeHtml(orderId)}</span></div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:20px;">
                
                <!-- Summary cards -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;">
                  <tr>
                    <td style="padding:14px;border:1px solid #e5e7eb;border-radius:14px;background:#fafafa;">
                      <div style="font-size:13px;color:#6b7280;margin-bottom:6px;">Billed To</div>
                      <div style="font-size:15px;font-weight:700;color:#111827;">${name}</div>
                      ${email ? `<div style="font-size:13px;color:#374151;margin-top:4px;">${email}</div>` : ""}
                      ${phone ? `<div style="font-size:13px;color:#374151;margin-top:2px;">${phone}</div>` : ""}
                      ${(address || city || state || zip) ? `<div style="font-size:12px;color:#6b7280;margin-top:8px;line-height:1.35;">
                        ${address ? `${address}<br/>` : ""}
                        ${city ? `${city}, ` : ""}${state ? `${state} ` : ""}${zip ? `${zip}` : ""}<br/>
                        ${country}
                      </div>` : ""}
                    </td>
                    <td style="width:12px;"></td>
                    <td style="padding:14px;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff;">
                      <div style="font-size:13px;color:#6b7280;margin-bottom:6px;">Payment</div>
                      <div style="font-size:22px;font-weight:800;color:#111827;">Rs ${money(totalPaid)}</div>
                      <div style="font-size:12px;color:#6b7280;margin-top:6px;">
                        Status: <span style="font-weight:700;color:#16a34a;">PAID</span><br/>
                        Gateway: <span style="font-weight:700;">${paymentGateway}</span><br/>
                        Order Status: <span style="font-weight:700;">${orderStatus}</span><br/>
                        ${createdAt ? `Date: <span style="font-weight:700;">${escapeHtml(createdAt)}</span>` : ""}
                      </div>
                    </td>
                  </tr>
                </table>

                <!-- Items table -->
                <div style="height:16px;"></div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
                  <tr style="background:#f3f4f6;">
                    <th align="left" style="padding:10px 10px;color:#374151;font-size:12px;font-weight:800;">Item</th>
                    <th align="left" style="padding:10px 10px;color:#374151;font-size:12px;font-weight:800;">Details</th>
                    <th align="center" style="padding:10px 10px;color:#374151;font-size:12px;font-weight:800;">Qty</th>
                    <th align="right" style="padding:10px 10px;color:#374151;font-size:12px;font-weight:800;">Price</th>
                    <th align="right" style="padding:10px 10px;color:#374151;font-size:12px;font-weight:800;">Total</th>
                  </tr>
                  ${itemsRows}
                </table>

                <!-- Totals -->
                <div style="height:16px;"></div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td></td>
                    <td style="width:320px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
                        <tr>
                          <td style="padding:10px 12px;color:#6b7280;font-size:13px;">Subtotal</td>
                          <td style="padding:10px 12px;text-align:right;color:#111827;font-size:13px;font-weight:700;">Rs ${money(totals.subtotal)}</td>
                        </tr>
                        <tr>
                          <td style="padding:10px 12px;color:#6b7280;font-size:13px;border-top:1px solid #eef2f7;">Shipping</td>
                          <td style="padding:10px 12px;text-align:right;color:#111827;font-size:13px;font-weight:700;border-top:1px solid #eef2f7;">Rs ${money(totals.shipping)}</td>
                        </tr>
                        <tr>
                          <td style="padding:10px 12px;color:#6b7280;font-size:13px;border-top:1px solid #eef2f7;">Tax</td>
                          <td style="padding:10px 12px;text-align:right;color:#111827;font-size:13px;font-weight:700;border-top:1px solid #eef2f7;">Rs ${money(totals.tax)}</td>
                        </tr>
                        ${showDiscount ? `
                          <tr>
                            <td style="padding:10px 12px;color:#6b7280;font-size:13px;border-top:1px solid #eef2f7;">Discount</td>
                            <td style="padding:10px 12px;text-align:right;color:#16a34a;font-size:13px;font-weight:800;border-top:1px solid #eef2f7;">-Rs ${money((totals.couponDiscount || 0) + (totals.coinsDiscount || 0))}</td>
                          </tr>
                        ` : ""}
                        <tr>
                          <td style="padding:12px 12px;color:#111827;font-size:14px;font-weight:900;border-top:1px solid #eef2f7;background:#fafafa;">Grand Total</td>
                          <td style="padding:12px 12px;text-align:right;color:#111827;font-size:16px;font-weight:900;border-top:1px solid #eef2f7;background:#fafafa;">Rs ${money(totalPaid)}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Footer note -->
                <div style="height:16px;"></div>
                <div style="padding:14px;border-radius:14px;background:#f8fafc;border:1px solid #e5e7eb;color:#475569;font-size:12px;line-height:1.5;">
                  If you have any questions, just reply to this email.
                  <div style="margin-top:8px;color:#64748b;">
                    © ${new Date().getFullYear()} ${escapeHtml(RECEIPT_FROM_NAME)} • All rights reserved
                  </div>
                </div>

              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </div>
  `;
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
    fromName: RECEIPT_FROM_NAME || null,
    logoUrl: RECEIPT_LOGO_URL || null,
    brandColor: RECEIPT_BRAND_COLOR || null,
    replyTo: RECEIPT_REPLY_TO || null,
    firebaseConfigured: Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim()),
  })
);

// GET test for UIS (only for sanity)
app.get("/paypro/uis", (req, res) => {
  res.json({ ok: true, message: "UIS is POST callback. GET is only for testing." });
});

// ✅ Initiate PayPro + SAVE REAL ORDER DOC PATH MAPPING
// Frontend MUST send: { orderId, amount, customer, description, appId, uid, orderDocId }
app.post("/api/paypro/initiate", async (req, res) => {
  try {
    requireEnvOrThrow();

    const { orderId, amount, customer, description, appId, uid, orderDocId } = req.body || {};

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId is required" });

    // required for real order update + receipt mapping
    if (!appId || !uid || !orderDocId) {
      return res.status(400).json({
        ok: false,
        message: "appId, uid, orderDocId are required (for real Firestore order update + receipt)",
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

    // ✅ store exact order doc path mapping for callback
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
          amount: numericAmount,
          redirectUrl: redirectUrl || null,
          status: "initiated",
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

// ✅ PayPro callback (marks paid in REAL order doc + sends receipt)
app.post("/paypro/uis", async (req, res) => {
  try {
    console.log("✅ PayPro UIS HIT");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    // PayPro sometimes uses different casing - normalize:
    const username = req.body?.username ?? req.body?.Username ?? req.body?.USERName;
    const password = req.body?.password ?? req.body?.Password ?? req.body?.PASSword;
    const csvinvoiceids =
      req.body?.csvinvoiceids ?? req.body?.CSVInvoiceIDs ?? req.body?.csvInvoiceIds;

    if (!username || !password || !csvinvoiceids) {
      return res.status(400).json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username/password/csvinvoiceids missing",
        },
      ]);
    }

    // verify callback creds
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

      // idempotency: agar already paid hai, dubara email na bhejo
      const alreadyPaid = String(mapping.status || "").toLowerCase() === "paid";

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

      // 2) Fetch REAL order doc for full receipt
      let orderDoc = null;
      try {
        const orderSnap = await fs.doc(mapping.orderDocPath).get();
        orderDoc = orderSnap.exists ? (orderSnap.data() || null) : null;
      } catch (e) {
        console.log("⚠️ order fetch failed:", orderId, e?.message || e);
      }

      // 3) Send receipt email (if email exists + not already paid)
      const email = String(mapping.email || orderDoc?.customer?.email || "").trim();
      const name = String(mapping.name || orderDoc?.customer?.fullName || "Customer").trim();
      const amount = Number(mapping.amount || orderDoc?.totalAmount || orderDoc?.payment?.amount || 0) || 0;

      if (!alreadyPaid && isEmailValid(email)) {
        try {
          const html = buildReceiptHtmlFromOrder({
            orderId,
            paidAmount: amount,
            orderDoc: orderDoc || {},
            logoUrl: RECEIPT_LOGO_URL || "",
          });

          await sendReceiptEmailResend({
            to: email,
            subject: `Receipt - Order ${orderId} (Paid)`,
            html,
            text: buildReceiptText({ orderId, customerName: name, total: amount }),
          });

          console.log("✅ Receipt sent:", orderId, "->", email);

          await fs.collection("paypro_mappings").doc(String(orderId)).set(
            {
              receiptSent: true,
              receiptSentAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        } catch (e) {
          console.log("⚠️ receipt send failed:", orderId, e?.message || e);
        }
      } else {
        if (alreadyPaid) console.log("ℹ️ Already paid (skip receipt):", orderId);
        else console.log("⚠️ No valid email in mapping/order for receipt:", orderId);
      }
    }

    // PayPro expects array response
    return res.status(200).json(
      makePayproAck(ids, true, "Invoice successfully marked as paid")
    );
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
