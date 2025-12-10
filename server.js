import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ================== ENV VARS ==================
const CLIENT_ID = process.env.PAYPRO_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET;

// e.g. https://sandbox.paypro.com.pk/v2
const PAYPRO_BASE_URL =
  process.env.PAYPRO_BASE_URL || "https://sandbox.paypro.com.pk/v2";

const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ ERROR: PayPro credentials missing in .env");
}
if (!FRONTEND_SUCCESS_URL || !FRONTEND_CANCEL_URL) {
  console.warn("⚠️ FRONTEND_SUCCESS_URL / FRONTEND_CANCEL_URL missing");
}

console.log("✅ Using PayPro base URL:", PAYPRO_BASE_URL);

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.send("PayPro backend is running...");
});

// ================== CREATE PAYMENT ==================
app.post("/api/paypro/create", async (req, res) => {
  try {
    const { amount, orderId } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({
        success: false,
        message: "amount and orderId are required",
      });
    }

    // ---- Call PayPro sandbox ----
    const url = `${PAYPRO_BASE_URL}/webcheckout`; // <-- important
    console.log("📡 Calling PayPro:", url, "amount:", amount, "orderId:", orderId);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ClientId: CLIENT_ID,
        ClientSecret: CLIENT_SECRET,
      },
      body: JSON.stringify({
        orderId,
        amount: amount.toString(),
        successUrl: FRONTEND_SUCCESS_URL,
        cancelUrl: FRONTEND_CANCEL_URL,
        customerEmail: "customer@example.com",
        customerPhone: "03001234567",
      }),
    });

    const text = await response.text();
    console.log("🔍 PayPro raw response status:", response.status);
    console.log("🔍 PayPro raw body:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("❌ Could not parse PayPro JSON:", e);
      return res.status(500).json({
        success: false,
        message: "Invalid JSON from PayPro",
        raw: text,
      });
    }

    // Agar PayPro ne khud error diya ho
    if (!response.ok || data.status === "error" || data.success === false) {
      console.error("❌ PayPro returned error:", data);
      return res.status(500).json({
        success: false,
        message: data.message || data.error || "PayPro API error",
        raw: data,
      });
    }

    const redirectUrl =
      data?.data?.redirectUrl || data?.redirectUrl || data?.url;

    if (!redirectUrl) {
      return res.status(500).json({
        success: false,
        message: "PayPro did not return redirectUrl",
        raw: data,
      });
    }

    // ✅ Success
    return res.json({
      success: true,
      paymentUrl: redirectUrl,
      raw: data,
    });
  } catch (err) {
    console.error("🔥 PayPro Error (catch):", err);
    return res.status(500).json({
      success: false,
      message: "Server error calling PayPro API",
      error: String(err),
    });
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
