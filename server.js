// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

// ----- Safepay Config -----
const PORT = process.env.PORT || 5000;

// Safepay PUBLIC (client) key
const SAFE_PAY_CLIENT = (process.env.SAFE_PAY_PUBLIC_KEY || "").trim();

// sandbox ya production
const SAFE_PAY_ENV = (process.env.SAFE_PAY_ENV || "sandbox").toLowerCase();

// Base URL Safepay ke liye
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
    const amount = Number(req.body.amount);
    const currency = req.body.currency || "PKR";

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (!SAFE_PAY_CLIENT) {
      return res.status(500).json({ error: "Safepay client key missing" });
    }

    console.log("Calling Safepay /order/v1/init with:", {
      SAFE_PAY_BASE_URL,
      SAFE_PAY_ENV,
      amount,
      currency,
    });

    const response = await axios.post(
      `${SAFE_PAY_BASE_URL}/order/v1/init`,
      {
        client: SAFE_PAY_CLIENT,
        amount,
        currency,
        environment: SAFE_PAY_ENV, // "sandbox" | "production"
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        // status manual handle karne ke liye
        validateStatus: () => true,
      }
    );

    console.log("Safepay status:", response.status);
    console.log("Safepay content-type:", response.headers["content-type"]);
    console.log("Safepay raw data:", response.data);

    const safepayData = response.data?.data || {};
    const token = safepayData.token;
    const environment = safepayData.environment || SAFE_PAY_ENV;

    if (response.status !== 200 || !token) {
      return res.status(500).json({
        error: "Invalid Safepay response (no token)",
        status: response.status,
        raw: response.data,
      });
    }

    // Frontend ke liye simple JSON
    return res.json({
      token,
      environment,
      successUrl: FRONTEND_SUCCESS_URL,
      cancelUrl: FRONTEND_CANCEL_URL,
    });
  } catch (err) {
    console.error("Safepay server error:", err?.response?.data || err);
    res.status(500).json({ error: "Safepay Error", details: err?.message });
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
