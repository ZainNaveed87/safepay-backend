import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // IMPORTANT for Node v22

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------
// ENV VARIABLES
// ------------------------------
const CLIENT_ID = process.env.PAYPRO_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET;

const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ ERROR: PayPro credentials missing in .env");
}

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (req, res) => {
  res.send("PayPro backend is running...");
});

// ------------------------------
// CREATE PAYMENT REQUEST
// ------------------------------
app.post("/api/paypro/create", async (req, res) => {
  try {
    const { amount, orderId } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({
        success: false,
        message: "amount and orderId are required",
      });
    }

    // -------------- PAYPRO API CALL --------------
    const response = await fetch("https://sandbox.paypro.com.pk/webcheckout", {
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
        customerEmail: "customer@example.com", // Optional
        customerPhone: "03001234567", // Optional
      }),
    });

    const data = await response.json();
    console.log("PAYPRO RESPONSE:", data);

    if (!data || !data?.data?.redirectUrl) {
      return res.status(500).json({
        success: false,
        message: "PayPro did not return redirectUrl",
        data,
      });
    }

    return res.json({
      success: true,
      payment_url: data.data.redirectUrl,
      raw: data,
    });
  } catch (err) {
    console.error("PayPro Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error calling PayPro API",
    });
  }
});


// ------------------------------
// SERVER START
// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
