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
    console.log("SAFE_PAY_SECRET_KEY present? ", !!process.env.SAFE_PAY_SECRET_KEY);

    const response = await axios.post(
      "https://sandbox.api.getsafepay.com/v1/orders",
      {
        amount: req.body.amount,
        currency: "PKR",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SAFE_PAY_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        maxRedirects: 0, // 🔸 redirect follow mat karo (important)
        validateStatus: () => true, // sab status codes allow
      }
    );

    console.log("Safepay status:", response.status);
    console.log("Safepay headers:", response.headers["content-type"]);
    console.log("Safepay raw data:", response.data);

    // agar 200 + JSON aaye to hi aage bhejo
    if (
      response.status === 200 &&
      typeof response.data === "object" &&
      response.data
    ) {
      return res.json(response.data);
    }

    // warna front-end ko clear error bhejo
    return res.status(500).json({
      error: "Invalid Safepay response",
      status: response.status,
      dataType: typeof response.data,
    });
  } catch (err) {
    console.error("Safepay server error:", err);
    res.status(500).json({ error: "Safepay Error" });
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
