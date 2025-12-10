import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ======== ENV =========
const CLIENT_ID = process.env.PAYPRO_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET;

// agar tum BASE_URL env me /v2 laga chuke ho to sirf wahi use kar lo
const PAYPRO_BASE_URL =
  process.env.PAYPRO_BASE_URL || "https://demoapi.paypro.com.pk/v2";

const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ ERROR: PayPro credentials missing in .env");
}

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("PayPro backend is running...");
});

// ===== CREATE PAYMENT =====
app.post("/api/paypro/create", async (req, res) => {
  try {
    const { amount, orderId } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({
        success: false,
        message: "amount and orderId are required",
      });
    }

    const url = `${PAYPRO_BASE_URL}/webcheckout`;
    console.log("Calling PayPro:", url);

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

    const data = await response.json();
    console.log("PAYPRO RAW RESPONSE:", data);

    if (!data || !data?.data?.redirectUrl) {
      return res.status(500).json({
        success: false,
        message: "PayPro did not return redirectUrl",
        data,
      });
    }

    return res.json({
      success: true,
      paymentUrl: data.data.redirectUrl,
      raw: data,
    });
  } catch (err) {
    console.error("PayPro Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error calling PayPro API",
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
