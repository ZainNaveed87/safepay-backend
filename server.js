// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV =====
const CLIENT_ID = process.env.PAYPRO_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET;
const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL;
const PAYPRO_BASE_URL =
  process.env.PAYPRO_BASE_URL || "https://sandbox.paypro.com.pk";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ ERROR: PayPro credentials missing in .env");
}

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("PayPro backend is running...");
});

// ===== CREATE PAYPRO PAYMENT =====
app.post("/api/paypro/create", async (req, res) => {
  const { amount, orderId } = req.body || {};

  console.log("🔹 Incoming create request:", { amount, orderId });

  if (!amount || !orderId) {
    return res.status(400).json({
      success: false,
      message: "amount and orderId are required",
    });
  }

  try {
    const url = `${PAYPRO_BASE_URL.replace(/\/$/, "")}/webcheckout`;

    const payload = {
      orderId,
      amount: amount.toString(),
      successUrl: FRONTEND_SUCCESS_URL,
      cancelUrl: FRONTEND_CANCEL_URL,
      customerEmail: "customer@example.com",
      customerPhone: "03001234567",
    };

    console.log("🔹 Calling PayPro:", url, "payload:", payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ClientId: CLIENT_ID,
        ClientSecret: CLIENT_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log("🔹 PayPro raw status:", response.status);
    console.log("🔹 PayPro raw body:", text);

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // PayPro ne JSON ki jagah HTML / plain text bhej diya
      return res.status(200).json({
        success: false,
        message: "PayPro returned a non-JSON response",
        status: response.status,
        body: text.slice(0, 500),
      });
    }

    // Response OK nahi ya redirectUrl nahi mila
    if (!response.ok || !json?.data?.redirectUrl) {
      return res.status(200).json({
        success: false,
        message:
          json.message ||
          json.error ||
          "PayPro returned an error response",
        status: response.status,
        raw: json,
      });
    }

    // ✅ Success
    return res.status(200).json({
      success: true,
      paymentUrl: json.data.redirectUrl,
      raw: json,
    });
  } catch (err) {
    console.error("❌ PayPro Error (catch):", err);

    return res.status(200).json({
      success: false,
      message:
        (err && err.message) || "Server error calling PayPro API (catch)",
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
