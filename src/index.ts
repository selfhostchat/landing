import { Hono } from "hono";

interface TrackingPayload {
  event: string;
  sessionId: string;
  surferId: string | null;
  timestamp: string;
  data: Record<string, unknown>;
}

interface EnvBindings {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  GOOGLE_SERVICE_ACCOUNT: string;
  GOOGLE_SHEET_ID: string;
}

const app = new Hono<{ Bindings: EnvBindings }>();

// Health check
app.get("/", (c) => c.json({ ok: true, service: "selfhostchat-tracking" }));

// Tracking endpoint
app.post("/track", async (c) => {
  let payload: TrackingPayload;
  try {
    payload = await c.req.json<TrackingPayload>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (!payload.event || !payload.sessionId) {
    return c.json({ ok: false, error: "Missing event or sessionId" }, 400);
  }

  // Gửi Telegram (nếu có config)
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  const chatId = c.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    const msg = formatMessage(payload);
    await sendTelegram(botToken, chatId, msg);
  }

  // Ghi Google Sheets (chỉ với lead mới)
  if (payload.event === "early_access_submit" && c.env.GOOGLE_SERVICE_ACCOUNT) {
    const sheetId = c.env.GOOGLE_SHEET_ID || "1Gjs9jU9zRPJ7XVo2nD42dSy5zannYO7D5IlASZQgrS0";
    const creds = JSON.parse(c.env.GOOGLE_SERVICE_ACCOUNT);
    const sheetName = "Leads";
    const row = buildSheetRow(payload);
    await appendToSheet(creds, sheetId, sheetName, row);
  }

  return c.json({ ok: true });
});

// ============================================================
// GOOGLE SHEETS
// ============================================================

async function getAccessToken(creds: {
  client_email: string;
  private_key: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: expiry,
      iat: now,
    })
  );

  const signingInput = `${header}.${payload}`;

  const privateKeyPem = creds.private_key
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----")
    .replace("-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----");

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const signature = base64url(new Uint8Array(sig));
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await resp.json();
  return data.access_token;
}

async function appendToSheet(
  creds: { client_email: string; private_key: string },
  sheetId: string,
  sheetName: string,
  row: (string | number | null)[]
): Promise<void> {
  const accessToken = await getAccessToken(creds);

  const range = `${sheetName}!A:A`;
  const values = { values: [row] };

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(values),
    }
  );
}

function buildSheetRow(p: TrackingPayload): (string | number | null)[] {
  const d = p.data;
  return [
    new Date(p.timestamp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
    p.surferId || "direct",
    p.sessionId,
    (d.name as string) || "",
    (d.email as string) || "",
    (d.company_size as string) || "",
    (d.note as string) || "",
    d.time_to_click !== undefined && d.time_to_click !== null ? `${d.time_to_click}s` : "",
    d.time_to_form_fill !== undefined && d.time_to_form_fill !== null ? `${d.time_to_form_fill}s` : "",
    p.event,
  ];
}

// ============================================================
// HELPERS
// ============================================================

function formatMessage(p: TrackingPayload): string {
  const surfer = p.surferId ? `\`${p.surferId}\`` : "direct";
  const session = `\`${p.sessionId}\``;
  const time = new Date(p.timestamp).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });

  switch (p.event) {
    case "page_view": {
      const firstVisit = p.data?.is_first_visit ? "Yes" : "No";
      return (
        `🌐 *Page View*\n` +
        `🌊 Surfer: ${surfer}\n` +
        `🔑 Session: ${session}\n` +
        `📍 First visit: ${firstVisit}\n` +
        `🕐 ${time}`
      );
    }

    case "early_access_click": {
      const location = (p.data?.location as string) || "unknown";
      const timeToClick = p.data?.time_to_click as number | null;
      const timeStr = timeToClick !== null ? formatDuration(timeToClick) : "-";
      return (
        `👆 *Early Access Clicked*\n` +
        `🌊 Surfer: ${surfer}\n` +
        `🔑 Session: ${session}\n` +
        `📍 Location: ${location}\n` +
        `⏱ Time to click: ${timeStr}\n` +
        `🕐 ${time}`
      );
    }

    case "early_access_submit": {
      const name = (p.data?.name as string) || "-";
      const email = (p.data?.email as string) || "-";
      const size = (p.data?.company_size as string) || "-";
      const note = (p.data?.note as string) || "-";
      const timeToClick = p.data?.time_to_click as number | null;
      const timeToFormFill = p.data?.time_to_form_fill as number | null;
      return (
        `🎉 *NEW LEAD!*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👤 *${name}*\n` +
        `📧 ${email}\n` +
        `👥 Size: ${size}\n` +
        `📝 ${note}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⏱ Time to click: ${timeToClick !== null ? formatDuration(timeToClick) : "-"}\n` +
        `⏱ Time to fill: ${timeToFormFill !== null ? formatDuration(timeToFormFill) : "-"}\n` +
        `🌊 Surfer: ${surfer}\n` +
        `🔑 Session: ${session}\n` +
        `🕐 ${time}`
      );
    }

    case "cta_click": {
      const href = (p.data?.href as string) || "-";
      const text = (p.data?.text as string) || "-";
      return (
        `🔗 *CTA Link Click*\n` +
        `🌊 Surfer: ${surfer}\n` +
        `🔑 Session: ${session}\n` +
        `🔗 Link: ${href}\n` +
        `📝 Text: ${text}\n` +
        `🕐 ${time}`
      );
    }

    default: {
      return (
        `📊 *Tracking Event*\n` +
        `🌊 Surfer: ${surfer}\n` +
        `🔑 Session: ${session}\n` +
        `📌 Event: \`${p.event}\`\n` +
        `🕐 ${time}`
      );
    }
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

// ============================================================
// BASE64 / PEM utilities
// ============================================================

function base64url(data: string): string {
  const bytes = new TextEncoder().encode(data);
  const len = bytes.length;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i], b2 = i + 1 < len ? bytes[i + 1] : 0, b3 = i + 2 < len ? bytes[i + 2] : 0;
    result += chars[b1 >> 2] + chars[((b1 & 3) << 4) | (b2 >> 4)] +
      (i + 1 < len ? chars[((b2 & 15) << 2) | (b3 >> 6)] : "=") +
      (i + 2 < len ? chars[b3 & 63] : "=");
  }
  return result;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----.*-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default app;
