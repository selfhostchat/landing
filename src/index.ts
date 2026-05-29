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
}

const app = new Hono<{ Bindings: EnvBindings }>();

// Health check
app.get("/", (c) => c.json({ ok: true, service: "selfhostchat-tracking" }));

// Tracking endpoint
app.post("/track", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  const chatId = c.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return c.json({ ok: false, error: "Telegram not configured" }, 503);
  }

  let payload: TrackingPayload;
  try {
    payload = await c.req.json<TrackingPayload>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (!payload.event || !payload.sessionId) {
    return c.json({ ok: false, error: "Missing event or sessionId" }, 400);
  }

  const msg = formatMessage(payload);
  await sendTelegram(botToken, chatId, msg);

  return c.json({ ok: true });
});

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

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

export default app;
