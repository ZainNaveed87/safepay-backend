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
  process.env.PAYPRO_RETURN_URL || "http://localhost:8080/payment/success";
const PAYPRO_CANCEL_URL =
  process.env.PAYPRO_CANCEL_URL || "http://localhost:8080/payment/cancel";

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

// ---- Receipt Branding (OPTIONAL) ----
const RECEIPT_LOGO_URL = (process.env.RECEIPT_LOGO_URL || "").trim(); // public https image url
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || RECEIPT_FROM_EMAIL || "").trim();
const SITE_URL = (process.env.SITE_URL || "https://secretsdiscounts.com").trim();
const BRAND_PRIMARY = (process.env.BRAND_PRIMARY || "#2563eb").trim(); // blue
const BRAND_ACCENT = (process.env.BRAND_ACCENT || "#22c55e").trim(); // green

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
  const s = String(str ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moneyPKR(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "Rs0";
  // Email receipts often look best without long decimals
  return `Rs ${x.toFixed(0)}`;
}

function safeDateLabel(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return new Date().toLocaleString();
    return d.toLocaleString();
  } catch {
    return new Date().toLocaleString();
  }
}

function normalizeVariantText(variant) {
  if (!variant || typeof variant !== "object") return "";
  const parts = [];
  if (variant.color) parts.push(`Color: ${variant.color}`);
  if (variant.size) parts.push(`Size: ${variant.size}`);
  if (variant.sku) parts.push(`SKU: ${variant.sku}`);
  // include any extra keys (optional)
  for (const [k, v] of Object.entries(variant)) {
    if (["color", "size", "sku"].includes(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(" • ");
}

function normalizeCustomizationText(customization) {
  if (!customization) return "";
  const blocks = Array.isArray(customization) ? customization : [customization];
  const lines = [];

  for (const block of blocks) {
    if (!block || !block.data) continue;
    const type = block.type === "image" ? "Image" : block.type === "text" ? "Text" : "Custom";

    if (Array.isArray(block.data)) {
      for (const obj of block.data) {
        if (!obj || typeof obj !== "object") continue;
        for (const [k, v] of Object.entries(obj)) {
          const vv = String(v ?? "").trim();
          if (!vv) continue;
          // Don’t include raw image URLs in text list; just mark as attached
          if (type === "Image") lines.push(`${k}: (image attached)`);
          else lines.push(`${k}: ${vv}`);
        }
      }
    } else if (typeof block.data === "object") {
      for (const [k, v] of Object.entries(block.data)) {
        const vv = String(v ?? "").trim();
        if (!vv) continue;
        if (type === "Image") lines.push(`${k}: (image attached)`);
        else lines.push(`${k}: ${vv}`);
      }
    }
  }

  return lines.join(" • ");
}

function buildReceiptHtmlFromOrder({ order, payproOrderId }) {
  const storeName = "Secrets Discounts";

  const orderId = order?.orderId || payproOrderId || "-";
  const createdAt = order?.paidAt || order?.updatedAt || order?.createdAt || order?.timestamp || null;

  const customer = order?.customer || {};
  const customerName = customer?.fullName || customer?.name || "Customer";
  const customerEmail = customer?.email || "";
  const customerPhone = customer?.phone || "";
  const customerAddress = customer?.address || "";
  const customerCity = customer?.city || "";
  const customerState = customer?.state || "";
  const customerZip = customer?.zipCode || "";

  const items = Array.isArray(order?.items) ? order.items : [];
  const subtotal = Number(order?.subtotal || 0);
  const shippingFee = Number(order?.shipping?.fee ?? order?.shippingFee ?? 0);
  const tax = Number(order?.tax || 0);

  const couponDiscount = Number(order?.couponDiscount || 0);
  const coinsDiscount = Number(order?.coinsDiscount || 0);
  const discountTotal = Number(order?.discount || (couponDiscount + coinsDiscount) || 0);

  const totalAmount = Number(order?.totalAmount ?? order?.payment?.amount ?? 0);
  const statusLabel = "Paid";
  const payMethod = "Online (PayPro)";

  const safeLogo = RECEIPT_LOGO_URL ? escapeHtml(RECEIPT_LOGO_URL) : "";

  const itemsHtml =
    items.length > 0
      ? items
          .map((it) => {
            const name = escapeHtml(it?.name || "Item");
            const img = (it?.image || "").trim();
            const qty = Number(it?.quantity || 1);
            const unit = Number(it?.price || 0);
            const line = unit * qty;

            const variantText = normalizeVariantText(it?.variant);
            const customText = normalizeCustomizationText(it?.customization);

            return `
              <tr>
                <td style="padding:12px 0;border-bottom:1px solid #eef2f7;">
                  <div style="display:flex;gap:12px;align-items:flex-start;">
                    ${
                      img
                        ? `<img src="${escapeHtml(img)}" alt="${name}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:12px;border:1px solid #e5e7eb;background:#f8fafc;" />`
                        : `<div style="width:56px;height:56px;border-radius:12px;border:1px solid #e5e7eb;background:#f8fafc;"></div>`
                    }
                    <div style="min-width:0;">
                      <div style="font-weight:700;color:#0f172a;line-height:1.25;">${name}</div>
                      ${
                        variantText
                          ? `<div style="margin-top:4px;font-size:12px;color:#475569;">${escapeHtml(
                              variantText
                            )}</div>`
                          : ""
                      }
                      ${
                        customText
                          ? `<div style="margin-top:4px;font-size:12px;color:#64748b;">${escapeHtml(
                              customText
                            )}</div>`
                          : ""
                      }
                      <div style="margin-top:6px;font-size:12px;color:#64748b;">
                        Qty: <b style="color:#0f172a;">${qty}</b> • Unit: <b style="color:#0f172a;">${moneyPKR(
              unit
            )}</b>
                      </div>
                    </div>
                  </div>
                </td>
                <td style="padding:12px 0;border-bottom:1px solid #eef2f7;text-align:right;white-space:nowrap;font-weight:700;color:#0f172a;">
                  ${moneyPKR(line)}
                </td>
              </tr>
            `;
          })
          .join("")
      : `
        <tr>
          <td style="padding:12px 0;color:#64748b;">Items detail not available.</td>
          <td style="padding:12px 0;text-align:right;color:#64748b;">-</td>
        </tr>
      `;

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif;background:#f5f7fb;padding:24px;">
    <div style="max-width:720px;margin:0 auto;">
      <div style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 30px rgba(2,6,23,0.06);">
        
        <!-- Header -->
        <div style="padding:18px 20px;background:linear-gradient(135deg, ${BRAND_PRIMARY}, #0ea5e9);color:#fff;">
          <div style="display:flex;align-items:center;gap:12px;">
            ${
              safeLogo
                ? `<img src="${safeLogo}" alt="${escapeHtml(
                    storeName
                  )}" style="width:42px;height:42px;border-radius:12px;object-fit:cover;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.2);" />`
                : `<div style="width:42px;height:42px;border-radius:12px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.2);"></div>`
            }
            <div style="min-width:0;">
              <div style="font-size:16px;font-weight:800;letter-spacing:0.2px;">${escapeHtml(
                storeName
              )}</div>
              <div style="font-size:12px;opacity:0.95;margin-top:2px;">Payment Receipt</div>
            </div>
            <div style="margin-left:auto;text-align:right;">
              <div style="display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.22);font-size:12px;font-weight:700;">
                ${escapeHtml(statusLabel)} ✅
              </div>
            </div>
          </div>
        </div>

        <!-- Body -->
        <div style="padding:18px 20px;">
          
          <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;">
            <div style="flex:1;min-width:260px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:12px;">
              <div style="font-size:12px;color:#64748b;">Order</div>
              <div style="font-size:16px;font-weight:800;color:#0f172a;margin-top:2px;">${escapeHtml(
                orderId
              )}</div>
              <div style="font-size:12px;color:#64748b;margin-top:6px;">
                Date: <b style="color:#0f172a;">${escapeHtml(safeDateLabel(createdAt))}</b><br/>
                Payment: <b style="color:#0f172a;">${escapeHtml(payMethod)}</b>
              </div>
            </div>

            <div style="flex:1;min-width:260px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:12px;">
              <div style="font-size:12px;color:#64748b;">Customer</div>
              <div style="font-size:14px;font-weight:800;color:#0f172a;margin-top:2px;">${escapeHtml(
                customerName
              )}</div>
              <div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.4;">
                ${customerEmail ? `Email: <b style="color:#0f172a;">${escapeHtml(customerEmail)}</b><br/>` : ""}
                ${customerPhone ? `Phone: <b style="color:#0f172a;">${escapeHtml(customerPhone)}</b><br/>` : ""}
                ${
                  customerAddress || customerCity || customerState || customerZip
                    ? `Address: <b style="color:#0f172a;">${escapeHtml(
                        [customerAddress, customerCity, customerState, customerZip].filter(Boolean).join(", ")
                      )}</b>`
                    : ""
                }
              </div>
            </div>
          </div>

          <!-- Items -->
          <div style="margin-top:14px;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <div style="padding:12px 14px;background:#ffffff;border-bottom:1px solid #e5e7eb;">
              <div style="font-weight:800;color:#0f172a;">Items</div>
            </div>
            <div style="padding:0 14px;background:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <thead>
                  <tr>
                    <th align="left" style="padding:12px 0;color:#64748b;font-size:12px;font-weight:700;border-bottom:1px solid #eef2f7;">Product</th>
                    <th align="right" style="padding:12px 0;color:#64748b;font-size:12px;font-weight:700;border-bottom:1px solid #eef2f7;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Totals -->
          <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:12px;">
            <div style="flex:1;min-width:260px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:12px;">
              <div style="font-weight:800;color:#0f172a;margin-bottom:8px;">Summary</div>

              <div style="display:flex;justify-content:space-between;margin:6px 0;color:#334155;font-size:13px;">
                <span>Subtotal</span><span style="font-weight:700;color:#0f172a;">${moneyPKR(subtotal)}</span>
              </div>

              <div style="display:flex;justify-content:space-between;margin:6px 0;color:#334155;font-size:13px;">
                <span>Shipping</span><span style="font-weight:700;color:#0f172a;">${moneyPKR(shippingFee)}</span>
              </div>

              <div style="display:flex;justify-content:space-between;margin:6px 0;color:#334155;font-size:13px;">
                <span>Tax</span><span style="font-weight:700;color:#0f172a;">${moneyPKR(tax)}</span>
              </div>

              ${
                discountTotal > 0
                  ? `<div style="display:flex;justify-content:space-between;margin:6px 0;color:#16a34a;font-size:13px;">
                      <span>Discount</span><span style="font-weight:800;">-${moneyPKR(discountTotal)}</span>
                    </div>`
                  : ""
              }

              <div style="margin-top:10px;border-top:1px dashed #e2e8f0;padding-top:10px;display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:14px;font-weight:900;color:#0f172a;">Paid Total</span>
                <span style="font-size:16px;font-weight:900;color:${BRAND_ACCENT};">${moneyPKR(
                  totalAmount
                )}</span>
              </div>
            </div>

            <div style="flex:1;min-width:260px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:12px;">
              <div style="font-weight:800;color:#0f172a;">Need help?</div>
              <div style="margin-top:6px;color:#475569;font-size:13px;line-height:1.45;">
                If you have any questions about your order, reply to this email or contact us.
              </div>
              ${
                SUPPORT_EMAIL
                  ? `<div style="margin-top:8px;font-size:13px;color:#0f172a;">
                      Support: <a href="mailto:${escapeHtml(
                        SUPPORT_EMAIL
                      )}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:800;">${escapeHtml(
                      SUPPORT_EMAIL
                    )}</a>
                    </div>`
                  : ""
              }
              ${
                SITE_URL
                  ? `<div style="margin-top:6px;font-size:13px;color:#0f172a;">
                      Website: <a href="${escapeHtml(
                        SITE_URL
                      )}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:800;">${escapeHtml(
                      SITE_URL
                    )}</a>
                    </div>`
                  : ""
              }
              <div style="margin-top:10px;font-size:12px;color:#64748b;">
                Payment reference: <b style="color:#0f172a;">${escapeHtml(payproOrderId || orderId)}</b>
              </div>
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div style="padding:14px 20px;background:#ffffff;border-top:1px solid #e5e7eb;color:#64748b;font-size:12px;">
          © ${new Date().getFullYear()} ${escapeHtml(storeName)} • Thank you for shopping with us.
        </div>
      </div>
    </div>
  </div>
  `;

  return html;
}

function buildFallbackReceiptHtml({ orderId, amount, customerName, customerEmail }) {
  const safeName = customerName ? String(customerName) : "Customer";
  const safeEmail = customerEmail ? String(customerEmail) : "";
  const safeAmount = Number(amount || 0);

  return `
  <div style="font-family: Arial, sans-serif; padding:16px; color:#111">
    <h2 style="margin:0 0 8px">Payment Successful ✅</h2>
    <p style="margin:0 0 12px">Hi <b>${escapeHtml(safeName)}</b>, thanks for your order!</p>
    <div style="border:1px solid #e5e7eb; border-radius:12px; padding:12px; background:#fafafa">
      <p style="margin:0 0 6px"><b>Order ID:</b> ${escapeHtml(orderId)}</p>
      <p style="margin:0 0 6px"><b>Paid Amount:</b> Rs ${safeAmount.toFixed(0)}</p>
      ${safeEmail ? `<p style="margin:0"><b>Email:</b> ${escapeHtml(safeEmail)}</p>` : ""}
    </div>
    <p style="margin:12px 0 0; color:#444">If you have any questions, reply to this email.</p>
    <p style="margin:18px 0 0; font-size:12px; color:#777">© ${new Date().getFullYear()} Secrets Discounts</p>
  </div>`;
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
    receiptLogo: RECEIPT_LOGO_URL || null,
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
      html: buildFallbackReceiptHtml({
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
          receiptSent: false,
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

// ✅ PayPro callback (marks paid in REAL order doc + sends FULL receipt)
// NOTE: PayPro may POST urlencoded; we already enabled express.urlencoded
app.post("/paypro/uis", async (req, res) => {
  try {
    console.log("✅ PayPro UIS HIT");
    console.log("Headers:", req.headers);
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

    for (const payproOrderId of ids) {
      let mapping = null;

      try {
        const mapSnap = await fs.collection("paypro_mappings").doc(String(payproOrderId)).get();
        mapping = mapSnap.exists ? mapSnap.data() || null : null;
      } catch (e) {
        console.log("⚠️ mapping read failed:", payproOrderId, e?.message || e);
      }

      if (!mapping?.orderDocPath) {
        console.log("⚠️ No mapping found for orderId:", payproOrderId);
        continue;
      }

      const alreadyPaid = String(mapping.status || "").toLowerCase() === "paid";
      const alreadyReceiptSent = Boolean(mapping.receiptSent);

      // 1) Update REAL order doc to Paid (idempotent merge)
      try {
        await fs.doc(mapping.orderDocPath).set(
          {
            orderStatus: "Paid",
            paymentMethod: "online",
            payment: {
              ...(mapping.payment || {}),
              method: "online",
              gateway: "paypro",
              status: "paid",
              amount: Number(mapping.amount || 0),
              payproOrderId: String(payproOrderId),
              updatedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
            paidAt: new Date().toISOString(),
          },
          { merge: true }
        );

        await fs.collection("paypro_mappings").doc(String(payproOrderId)).set(
          {
            status: "paid",
            paidAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastCallbackAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (e) {
        console.log("⚠️ order doc update failed:", payproOrderId, e?.message || e);
      }

      // 2) Fetch order doc (for full receipt)
      let orderData = null;
      try {
        const orderSnap = await fs.doc(mapping.orderDocPath).get();
        orderData = orderSnap.exists ? orderSnap.data() || null : null;
      } catch (e) {
        console.log("⚠️ order doc read failed:", payproOrderId, e?.message || e);
      }

      // 3) Send receipt email (only once)
      const email = String(mapping.email || orderData?.customer?.email || "").trim();
      const name = String(mapping.name || orderData?.customer?.fullName || "Customer").trim();
      const amount = Number(orderData?.totalAmount ?? orderData?.payment?.amount ?? mapping.amount ?? 0) || 0;

      if (alreadyReceiptSent) {
        console.log("ℹ️ Receipt already sent (skip):", payproOrderId);
        continue;
      }

      if (isEmailValid(email)) {
        try {
          const html = orderData
            ? buildReceiptHtmlFromOrder({ order: orderData, payproOrderId })
            : buildFallbackReceiptHtml({
                orderId: String(payproOrderId),
                amount,
                customerName: name,
                customerEmail: email,
              });

          await sendReceiptEmailResend({
            to: email,
            subject: `Receipt - Order ${payproOrderId} (Paid)`,
            html,
          });

          console.log("✅ Receipt sent:", payproOrderId, "->", email);

          await fs.collection("paypro_mappings").doc(String(payproOrderId)).set(
            {
              receiptSent: true,
              receiptSentAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );

          // Optional: also mark on order doc
          try {
            await fs.doc(mapping.orderDocPath).set(
              {
                receiptSent: true,
                receiptSentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
          } catch {
            // ignore
          }
        } catch (e) {
          console.log("⚠️ receipt send failed:", payproOrderId, e?.message || e);
        }
      } else {
        console.log("⚠️ No valid email for receipt:", payproOrderId, email);
      }

      if (alreadyPaid && !alreadyReceiptSent) {
        // paid earlier but receipt not sent; above logic will still send it once
        console.log("ℹ️ Order was already paid, sent receipt now (if email valid):", payproOrderId);
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
