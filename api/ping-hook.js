const crypto = require("crypto");

const SMS_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/sms";
const VIBER_ENDPOINT = "https://ping.leadit.rs/api/v1/open/message/viber-image";

function createMessageId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return Date.now().toString();
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const {
    phone_number: phoneNumber,
    channel_preference: channelPreference,
    message,
  } = req.body || {};

  if (!phoneNumber || !channelPreference) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Missing required fields: phone_number and channel_preference.",
    });
  }

  if (!["sms", "viber", "viber-fallback"].includes(channelPreference)) {
    return res.status(400).json({
      error: "Bad Request",
      message:
        "Invalid channel_preference. Expected one of: sms, viber, viber-fallback.",
    });
  }

  if (
    !process.env.GMD_API_TOKEN ||
    !process.env.GMD_SMS_SENDER_NAME ||
    !process.env.GMD_VIBER_SENDER_NAME
  ) {
    return res.status(500).json({
      error: "Server configuration error",
      message:
        "Missing GMD_API_TOKEN, GMD_SMS_SENDER_NAME, or GMD_VIBER_SENDER_NAME environment variable.",
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
      const errorBody = await gmdResponse.text();
      throw new Error(
        `GMD API request failed with status ${gmdResponse.status}: ${errorBody}`
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
