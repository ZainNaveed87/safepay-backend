// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

// ----- Safepay Config -----
const PORT = process.env.PORT || 5000;

// Safepay PUBLIC key (yeh hi "client" hota hai)
const SAFE_PAY_CLIENT = process.env.SAFE_PAY_PUBLIC_KEY;

// sandbox ya production
const SAFE_PAY_ENV = process.env.SAFE_PAY_ENV || "sandbox";

// Order init endpoint
const SAFE_PAY_ORDER_URL =
  SAFE_PAY_ENV === "production"
    ? "https://api.getsafepay.com/order/v1/init"
    : "https://sandbox.api.getsafepay.com/order/v1/init";

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
// --------- Safepay create checkout ---------
app.post("/api/safepay/create", async (req, res) => {
  try {
    const { amount, currency = "PKR", orderId } = req.body;
    
    console.log("=== SAFEPAY ORDER CREATION ===");
    console.log("Amount:", amount);
    console.log("Currency:", currency);
    console.log("Order ID:", orderId);
    console.log("Using base URL:", SAFE_PAY_BASE_URL);

    // IMPORTANT: Safepay expects amount in paisa (smallest currency unit)
    // For PKR, multiply by 100
    const amountInPaisa = Math.round(amount * 100);
    
    const requestBody = {
      amount: amountInPaisa,
      currency: currency,
      client: {
        redirect_url: FRONTEND_SUCCESS_URL,
        cancel_url: FRONTEND_CANCEL_URL
      },
      metadata: {
        order_id: orderId || `ORD-${Date.now()}`,
        source: "your-website"
      }
    };

    console.log("Request body:", JSON.stringify(requestBody, null, 2));

    const response = await axios.post(
      `${SAFE_PAY_BASE_URL}/order/v1/init`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SAFE_PAY_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-KEY': process.env.SAFE_PAY_PUBLIC_KEY
        }
      }
    );

    console.log("Safepay Response Status:", response.status);
    console.log("Safepay Response Data:", JSON.stringify(response.data, null, 2));

    if (response.data && response.data.data) {
      const safepayData = response.data.data;
      
      // Safepay returns 'tracker' or 'beacon' as the payment token
      const token = safepayData.tracker || safepayData.beacon;
      
      if (!token) {
        console.error("No token in response:", safepayData);
        return res.status(500).json({
          error: "No payment token received from Safepay",
          data: safepayData
        });
      }

      // Return data to frontend
      return res.json({
        success: true,
        token: token,
        tracker: token,
        environment: SAFE_PAY_ENV,
        checkout_url: `${SAFE_PAY_BASE_URL}/checkout/pay?beacon=${token}`,
        data: safepayData
      });
    }

    return res.status(500).json({
      error: "Invalid response format from Safepay",
      data: response.data
    });

  } catch (error) {
    console.error("=== SAFEPAY ERROR ===");
    
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Headers:", error.response.headers);
      console.error("Data:", error.response.data);
      
      // Safepay specific error
      if (error.response.status === 401) {
        return res.status(401).json({
          error: "Safepay Authentication Failed",
          message: "Check your API keys. Make sure you're using Sandbox keys for sandbox environment.",
          debug: "Status 401: Unauthorized"
        });
      }
      
      return res.status(error.response.status).json({
        error: "Safepay API Error",
        status: error.response.status,
        message: error.response.data?.message || error.response.statusText,
        data: error.response.data
      });
    } else if (error.request) {
      console.error("No response received");
      return res.status(503).json({
        error: "Safepay API Unavailable",
        message: "Could not connect to Safepay. Please check your network."
      });
    } else {
      console.error("Request error:", error.message);
      return res.status(500).json({
        error: "Failed to create order",
        message: error.message
      });
    }
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
