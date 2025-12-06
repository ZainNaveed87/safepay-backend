// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

// 🟦 CORS – apne frontend ka origin allow karo
app.use(
  cors({
    origin: [
      "http://localhost:8080",   // Vite dev
      "http://localhost:5173",   // agar kabhi ye use ho
      // "https://tumhara-front-domain.com",  // baad me production
    ],
    credentials: true,
  })
);

app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("Safepay backend running...");
});

// ✅ Safepay: create order
app.post("/api/safepay/create", async (req, res) => {
  try {
    const response = await axios.post(
      "https://sandbox.api.getsafepay.com/v1/orders",
      {
        amount: req.body.amount, // e.g. 5000 (PKR 50.00)
        currency: "PKR",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SAFE_PAY_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (err) {
    console.log("Safepay error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Safepay Error" });
  }
});

// ✅ Safepay webhook
app.post("/api/safepay/webhook", (req, res) => {
  console.log("Webhook received:", req.body);
  res.sendStatus(200);
});

// 🔴 Render yahan se PORT set karega
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
