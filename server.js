// ================================
// server.js — PayPro FINAL VERSION
// ================================

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ------------ ENV DATA ------------
const PORT = process.env.PORT || 5000;
const PAYPRO_BASE = process.env.PAYPRO_BASE_URL;
const CLIENT_ID = process.env.PAYPRO_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPRO_CLIENT_SECRET;

// ------------ Generate Token ------------
async function getPayProToken() {
  const resp = await fetch(`${PAYPRO_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  });

  const data = await resp.json();

  if (!data.success) {
    console.error("PayPro Auth Error:", data);
    throw new Error("Failed to authenticate with PayPro.");
  }

  return data.token;
}

// ------------ Create PayPro Order ------------
app.post("/api/paypro/create", async (req, res) => {
  try {
    const { amount, orderId, customer } = req.body;

    if (!amount || !orderId || !customer) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Generate token
    const token = await getPayProToken();

    // Create PayPro Order
    const response = await fetch(`${PAYPRO_BASE}/order/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merchantOrderId: orderId,
        amount: amount,
        consumerName: customer.fullName,
        consumerMobile: customer.phone,
        consumerEmail: customer.email,
      }),
    });

    const data = await response.json();

    if (!data.success) {
      console.error("PayPro Order Error:", data);
      return res.status(400).json({
        success: false,
        error: data.message || "PayPro order failed",
      });
    }

    // Success — return URL to frontend
    res.json({
      success: true,
      payproId: data.payProId,
      paymentUrl: data.paymentUrl,
    });
  } catch (error) {
    console.error("PayPro Create Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

// ------------ Start Server ------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
