import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Safepay backend running...");
});

app.post("/api/safepay/create", async (req, res) => {
  try {
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
      }
    );

    res.json(response.data);
  } catch (err) {
    console.log(err.response?.data);
    res.status(500).json({ error: "Safepay Error" });
  }
});

app.post("/api/safepay/webhook", (req, res) => {
  console.log("Webhook received:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
