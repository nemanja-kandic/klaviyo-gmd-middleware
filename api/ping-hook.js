const crypto = require("crypto");

const SMS_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/sms";
const VIBER_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/viber-image";
const KLAVIYO_EVENTS_ENDPOINT = "https://a.klaviyo.com/api/events";
const KLAVIYO_API_REVISION = "2026-04-15";
const ALLOWED_CHANNELS = new Set(["sms", "viber", "viber-fallback"]);
const MAX_MESSAGE_LENGTH = 1000;
const MAX_REQUEST_BODY_BYTES = 5000;
const MAX_CAMPAIGN_NAME_LENGTH = 120;
const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function truncate(value, maxLength) {
  const text = String(value || "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function isValidEmail(email) {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim());
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

async function recordKlaviyoEvent({
  metricName,
  email,
  phoneNumber,
  campaignName,
  channelPreference,
  message,
  messageId,
  status,
  gmdStatus,
  errorReason,
}) {
  if (!process.env.KLAVIYO_PRIVATE_API_KEY) {
    console.error("Klaviyo event logging is not configured", { messageId });
    return false;
  }

  const profileAttributes = {};

  if (isValidEmail(email)) {
    profileAttributes.email = email.trim();
  }

  if (typeof phoneNumber === "string" && PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    profileAttributes.phone_number = phoneNumber;
  }

  if (!profileAttributes.email && !profileAttributes.phone_number) {
    console.error("Klaviyo event logging skipped: missing profile identifier", {
      messageId,
      status,
    });
    return false;
  }

  const eventPayload = {
    data: {
      type: "event",
      attributes: {
        properties: {
          campaign_name: truncate(
            campaignName || "Unspecified campaign",
            MAX_CAMPAIGN_NAME_LENGTH
          ),
          channel_preference: channelPreference,
          phone_number: phoneNumber,
          message_id: messageId,
          status,
          gmd_status: gmdStatus || null,
          error_reason: errorReason || null,
          message_length: typeof message === "string" ? message.length : 0,
          source: "klaviyo-gmd-middleware",
        },
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: metricName,
            },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: profileAttributes,
          },
        },
        time: new Date().toISOString(),
        unique_id: `${messageId}-${metricName.toLowerCase().replace(/\s+/g, "-")}`,
      },
    },
  };

  try {
    const response = await fetch(KLAVIYO_EVENTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        revision: KLAVIYO_API_REVISION,
      },
      body: JSON.stringify(eventPayload),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      console.error("Klaviyo event logging failed", {
        status: response.status,
        messageId,
        metricName,
        body: truncate(responseBody, 500),
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Klaviyo event logging failed", {
      messageId,
      metricName,
      message: error.message,
    });
    return false;
  }
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
    !process.env.GMD_VIBER_SENDER_NAME ||
    !process.env.KLAVIYO_PRIVATE_API_KEY
  ) {
    return res.status(500).json({
      error: "Server configuration error",
      message: "GMD or Klaviyo integration is not configured.",
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
    email,
    campaign_name: campaignName,
    channel_preference: channelPreference,
    message,
  } = body;
  const messageId = createMessageId();

  async function rejectInvalidRequest(publicMessage, errorReason) {
    await recordKlaviyoEvent({
      metricName: "GMD Message Failed",
      email,
      phoneNumber,
      campaignName,
      channelPreference,
      message,
      messageId,
      status: "validation_failed",
      errorReason,
    });

    return res.status(400).json({
      error: "Bad Request",
      message: publicMessage,
      messageId,
    });
  }

  if (!phoneNumber || !channelPreference || !message || !campaignName) {
    return rejectInvalidRequest(
      "Missing required fields: phone_number, channel_preference, message, and campaign_name.",
      "Missing required fields."
    );
  }

  if (!ALLOWED_CHANNELS.has(channelPreference)) {
    return rejectInvalidRequest(
      "Invalid channel_preference. Expected one of: sms, viber, viber-fallback.",
      `Invalid channel_preference: ${channelPreference}`
    );
  }

  if (typeof phoneNumber !== "string" || !PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    return rejectInvalidRequest(
      "Invalid phone_number. Expected E.164 format, e.g. +381601234567.",
      `Invalid phone_number: ${phoneNumber}`
    );
  }

  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    return rejectInvalidRequest(
      `Invalid message. Expected a string up to ${MAX_MESSAGE_LENGTH} characters.`,
      "Invalid message."
    );
  }

  if (
    typeof campaignName !== "string" ||
    campaignName.trim().length === 0 ||
    campaignName.length > MAX_CAMPAIGN_NAME_LENGTH
  ) {
    return rejectInvalidRequest(
      `Invalid campaign_name. Expected a string up to ${MAX_CAMPAIGN_NAME_LENGTH} characters.`,
      "Invalid campaign_name."
    );
  }

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
      const errorBody = await gmdResponse.text();
      console.error("GMD API request failed", {
        status: gmdResponse.status,
        messageId,
      });

      await recordKlaviyoEvent({
        metricName: "GMD Message Failed",
        email,
        phoneNumber,
        campaignName,
        channelPreference,
        message,
        messageId,
        status: "rejected_by_gmd",
        gmdStatus: gmdResponse.status,
        errorReason: `GMD API request failed with status ${gmdResponse.status}: ${truncate(errorBody, 300)}`,
      });

      throw new Error(
        `GMD API request failed with status ${gmdResponse.status}`
      );
    }

    await recordKlaviyoEvent({
      metricName: "GMD Message Accepted",
      email,
      phoneNumber,
      campaignName,
      channelPreference,
      message,
      messageId,
      status: "accepted_by_gmd",
      gmdStatus: gmdResponse.status,
    });

    return res.status(200).json({ success: true, messageId });
  } catch (error) {
    return res.status(500).json({
      error: "GMD API request failed",
      message: error.message,
      messageId,
    });
  }
};
