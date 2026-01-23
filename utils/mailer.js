const nodemailer = require("nodemailer");

function makeTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("Missing SMTP env vars (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)");
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // 587 => false
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendReceiptEmail({ to, subject, html, attachments = [] }) {
  const transporter = makeTransporter();

  const fromName = process.env.RECEIPT_FROM_NAME || "Secrets Discounts";
  const from = `${fromName} <${process.env.SMTP_USER}>`;

  return transporter.sendMail({
    from,
    to,
    subject,
    html,
    attachments,
  });
}

module.exports = { sendReceiptEmail };
