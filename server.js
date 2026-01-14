// server/index.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- CONFIG (ENV recommended) --------------------
const PAYPRO_BASE = "https://demoapi.paypro.com.pk/v2";

// PayPro Auth (clientid/clientsecret) :contentReference[oaicite:3]{index=3}
const PAYPRO_CLIENT_ID = process.env.PAYPRO_CLIENT_ID || "YOUR_CLIENT_ID";
const PAYPRO_CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET || "YOUR_CLIENT_SECRET";

// MerchantId (provided username) order create body me jata hai :contentReference[oaicite:4]{index=4}
const PAYPRO_MERCHANT_ID = process.env.PAYPRO_MERCHANT_ID || "YOUR_MERCHANT_USERNAME";

// Callback basic auth (PayPro tumhari API ko username/password bhejta hai) :contentReference[oaicite:5]{index=5}
const CALLBACK_USERNAME = process.env.PAYPRO_CALLBACK_USERNAME || "xyz";
const CALLBACK_PASSWORD = process.env.PAYPRO_CALLBACK_PASSWORD || "xyz";

// optional: frontend base url (after payment redirect if needed)
const FRONTEND_BASE = process.env.FRONTEND_BASE || "http://localhost:5173";

// -------------------- HELPERS --------------------
async function payproAuthToken() {
  const res = await fetch(`${PAYPRO_BASE}/ppro/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientid: PAYPRO_CLIENT_ID,
      clientsecret: PAYPRO_CLIENT_SECRET,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || "PayPro auth failed");
  }

  // PayPro doc me token headers me "Token" key se use hota hai :contentReference[oaicite:6]{index=6}
  // Demo responses vary; commonly token value in data.token / data.Token etc.
  const token =
    data?.token ||
    data?.Token ||
    data?.access_token ||
    data?.AccessToken ||
    data?.AuthorizationToken;

  if (!token) {
    throw new Error("PayPro token missing in response");
  }
  return token;
}

function ddmmyyyy(date = new Date()) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

// -------------------- ROUTE A: Create PayPro Order --------------------
// Frontend => POST /api/paypro/create-order
// Backend => token => create order => return paymentUrl/cpayId
app.post("/api/paypro/create-order", async (req, res) => {
  try {
    const { orderId, amount, customerName, customerEmail, customerMobile } = req.body || {};

    if (!orderId || !amount) {
      return res.status(400).json({ error: "orderId and amount are required" });
    }

    const token = await payproAuthToken();

    // Create Single Order body format PDF me array hai: [ {MerchantId}, {OrderData} ] :contentReference[oaicite:7]{index=7}
    const body = [
      { MerchantId: PAYPRO_MERCHANT_ID },
      {
        OrderNumber: orderId,
        OrderAmount: String(amount),
        OrderDueDate: ddmmyyyy(plusDays(2)),
        OrderType: "Service",
        IssueDate: ddmmyyyy(new Date()),
        OrderExpireAfterSeconds: "0",
        CustomerName: customerName || "Customer",
        CustomerMobile: customerMobile || "",
        CustomerEmail: customerEmail || "",
        CustomerAddress: "",
      },
    ];

    const r = await fetch(`${PAYPRO_BASE}/ppro/co`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: token, // NOTE: header key "Token" :contentReference[oaicite:8]{index=8}
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(500).json({ error: "PayPro create order failed", raw: data });
    }

    // PayPro response fields docs me screenshot based; usually cpayId/paymentUrl/orderNumber
    const cpayId = data?.cpayId || data?.CPayId || data?.cpay_id || data?.InvoiceId || data?.invoiceId;
    const paymentUrl =
      data?.paymentUrl ||
      data?.PaymentUrl ||
      data?.url ||
      data?.URL ||
      data?.checkoutUrl;

    // If paymentUrl is not directly provided, you may need to build it from cpayId (depends on PayPro response).
    // We'll return whatever we have; you can inspect console/log if needed.
    return res.json({
      orderNumber: orderId,
      cpayId: cpayId || null,
      paymentUrl: paymentUrl || null,
      raw: data,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// -------------------- ROUTE B: Callback API --------------------
// PayPro => POST https://{ClientDomainName}/paypro/uis :contentReference[oaicite:9]{index=9}
// Body: { username,password,csvinvoiceids } :contentReference[oaicite:10]{index=10}
app.post("/paypro/uis", async (req, res) => {
  try {
    const { username, password, csvinvoiceids } = req.body || {};

    // auth validate
    if (!username || !password || username !== CALLBACK_USERNAME || password !== CALLBACK_PASSWORD) {
      return res.json([
        {
          StatusCode: "01",
          InvoiceID: null,
          Description: "Invalid Data. Username or password is invalid",
        },
      ]);
    }

    if (!csvinvoiceids || typeof csvinvoiceids !== "string") {
      return res.json([
        {
          StatusCode: "03",
          InvoiceID: null,
          Description: "No data available",
        },
      ]);
    }

    const ids = csvinvoiceids.split(",").map((s) => s.trim()).filter(Boolean);

    // ✅ YAHAN TUM APNA DB/Firestore UPDATE KAROGE
    // Filhal demo: we just return success for each id
    const result = ids.map((id) => ({
      StatusCode: "00",
      InvoiceID: id,
      Description: "Invoice successfully marked as paid",
    }));

    return res.json(result);
  } catch (e) {
    return res.json([
      {
        StatusCode: "02",
        InvoiceID: null,
        Description: "Service Failure",
      },
    ]);
  }
});

// -------------------- START --------------------
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`PayPro backend running on port ${PORT}`));
