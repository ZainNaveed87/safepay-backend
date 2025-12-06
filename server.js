// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

// ----- Safepay Config -----
const PORT = process.env.PORT || 5000;

// Safepay public key (staging / test wali)
const SAFE_PAY_CLIENT = process.env.SAFE_PAY_PUBLIC_KEY;

// sandbox ya production
const SAFE_PAY_ENV = process.env.SAFE_PAY_ENV || "sandbox";

const SAFE_PAY_BASE_URL =
  SAFE_PAY_ENV === "production"
    ? "https://api.getsafepay.com"
    : "https://sandbox.api.getsafepay.com";

// React app ke success / cancel routes
const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL;

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:8080", "*"],
    credentials: true,
  })
);
app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("Safepay backend running...");
});

// --------- Safepay create checkout ---------
app.post("/api/safepay/create", async (req, res) => {
  try {
    const { amount, currency = "PKR", orderId } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount is required" });
    }

    // 1) Safepay ko order init request
    const body = {
      client: SAFE_PAY_CLIENT,
      amount: Number(amount),
      currency,
      environment: SAFE_PAY_ENV,
    };

    // IMPORTANT: ye wahi endpoint hai jo Safepay examples me hai
    const initUrl = `${SAFE_PAY_BASE_URL}/order/v1/init`;

    const safepayResp = await axios.post(initUrl, body);
    const token = safepayResp.data?.data?.token;

    if (!token) {
      console.error("Safepay init response without token:", safepayResp.data);
      return res
        .status(500)
        .json({ error: "Safepay token not found in response" });
    }

    // 2) Ab checkout URL banaate hain
    const qs = new URLSearchParams({
      env: SAFE_PAY_ENV,
      beacon: token, // Safepay ka token
      source: "website",
      order_id: orderId || `ORD-${Date.now()}`,
    });

    if (FRONTEND_SUCCESS_URL) {
      qs.append("redirect_url", FRONTEND_SUCCESS_URL);
    }
    if (FRONTEND_CANCEL_URL) {
      qs.append("cancel_url", FRONTEND_CANCEL_URL);
    }

    const checkoutUrl = `${SAFE_PAY_BASE_URL}/components?${qs.toString()}`;

    // Frontend ko simple, clean response
    return res.json({
      checkoutUrl,
      token,
    });
  } catch (err) {
    console.error(
      "Safepay init error:",
      err.response?.data || err.message || err
    );
    return res.status(500).json({
      error: "Safepay Error",
      details: err.response?.data || err.message || "Unknown error",
    });
  }
});

// --------- Webhook (abhi sirf log) ---------
app.post("/api/safepay/webhook", (req, res) => {
  console.log("Safepay webhook received:", req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
