const crypto = require("crypto");

const SMS_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/sms";
const VIBER_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/viber-image";
const ALLOWED_CHANNELS = new Set(["sms", "viber", "viber-fallback"]);
const MAX_MESSAGE_LENGTH = 1000;
const MAX_REQUEST_BODY_BYTES = 5000;
const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;

function createMessageId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return Date.now().toString();
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return value || "";
}

function parseBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  return null;
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildGmdRequest({ phoneNumber, channelPreference, message, messageId }) {
  if (channelPreference === "sms") {
    return {
      endpoint: SMS_ENDPOINT,
      payload: [
        {
          channelCode: "MAIN_SMS_HUB",
          sender: process.env.GMD_SMS_SENDER_NAME,
          text: message,
          destinations: [{ to: phoneNumber, messageId }],
        },
      ],
    };
  }

  const payload = {
    to: phoneNumber,
    messageId,
    channelCode: "VIBER_GATEWAY_3",
    sender: process.env.GMD_VIBER_SENDER_NAME,
    body: message,
  };

  if (channelPreference === "viber-fallback") {
    payload.fallbackMessageDataByTypes = [
      {
        messageType: "SMS",
        order: 1,
        fallbackMessageData: { body: message },
      },
    ];
  }

  return {
    endpoint: VIBER_ENDPOINT,
    payload,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!process.env.KLAVIYO_WEBHOOK_SECRET) {
    return res.status(500).json({
      error: "Server configuration error",
      message: "Webhook is not configured.",
    });
  }

  const webhookSecret = getHeader(req, "x-webhook-secret");

  if (!safeCompare(webhookSecret, process.env.KLAVIYO_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (
    !process.env.GMD_API_TOKEN ||
    !process.env.GMD_SMS_SENDER_NAME ||
    !process.env.GMD_VIBER_SENDER_NAME
  ) {
    return res.status(500).json({
      error: "Server configuration error",
      message: "GMD integration is not configured.",
    });
  }

  const contentType = getHeader(req, "content-type").toLowerCase();

  if (!contentType.includes("application/json")) {
    return res.status(415).json({
      error: "Unsupported Media Type",
      message: "Expected application/json request body.",
    });
  }

  const contentLength = Number(getHeader(req, "content-length"));

  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    return res.status(413).json({
      error: "Payload Too Large",
      message: `Request body must be ${MAX_REQUEST_BODY_BYTES} bytes or smaller.`,
    });
  }

  const body = parseBody(req);

  if (!body) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Invalid JSON body.",
    });
  }

  const {
    phone_number: phoneNumber,
    channel_preference: channelPreference,
    message,
  } = body;

  if (!phoneNumber || !channelPreference || !message) {
    return res.status(400).json({
      error: "Bad Request",
      message:
        "Missing required fields: phone_number, channel_preference, and message.",
    });
  }

  if (!ALLOWED_CHANNELS.has(channelPreference)) {
    return res.status(400).json({
      error: "Bad Request",
      message:
        "Invalid channel_preference. Expected one of: sms, viber, viber-fallback.",
    });
  }

  if (typeof phoneNumber !== "string" || !PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Invalid phone_number. Expected E.164 format, e.g. +381601234567.",
    });
  }

  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    return res.status(400).json({
      error: "Bad Request",
      message: `Invalid message. Expected a string up to ${MAX_MESSAGE_LENGTH} characters.`,
    });
  }

  const messageId = createMessageId();
  const { endpoint, payload } = buildGmdRequest({
    phoneNumber,
    channelPreference,
    message,
    messageId,
  });

  try {
    const gmdResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GMD_API_TOKEN}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(payload),
    });

    if (!gmdResponse.ok) {
      await gmdResponse.text();
      console.error("GMD API request failed", {
        status: gmdResponse.status,
        messageId,
      });

      throw new Error(
        `GMD API request failed with status ${gmdResponse.status}`
      );
    }

    return res.status(200).json({ success: true, messageId });
  } catch (error) {
    return res.status(500).json({
      error: "GMD API request failed",
      message: error.message,
      messageId,
    });
  }
};
