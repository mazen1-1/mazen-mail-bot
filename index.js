/**
 * Zoho Mail  ➜  Telegram Bot  |  Cloudflare Worker (ES Modules)
 * Endpoints:
 *   POST /webhook/email?key=SECRET   ← Zoho Mail
 *   POST /webhook/telegram           ← Telegram (يتحقق عبر Secret Token + Chat ID)
 *   GET  /                           ← Health check
 */

// ───────────── الإعدادات ─────────────
const CONFIG = {
  BOT_TOKEN: "8632326691:AAE8jtBuYVRsdALKQ4rOMWHl-v7IN2YEe20",
  CHAT_ID: "8560196010",
  // غيّره إلى قيمة طويلة عشوائية (حروف وأرقام و _ - فقط)
  WEBHOOK_SECRET: "mazen.2011.4.2",
  MAX_BODY_CHARS: 3000,
  TELEGRAM_API: "https://api.telegram.org",
};

// ───────────── أدوات مساعدة ─────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const escapeHtml = (str = "") =>
  String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const stripHtml = (html = "") =>
  String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const truncate = (text, max) =>
  text.length > max ? text.slice(0, max).trimEnd() + "…" : text;

// مقارنة آمنة ضد هجمات التوقيت
const safeEqual = (a = "", b = "") => {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};

// قراءة JSON أو Form-data بشكل مرن
async function parsePayload(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return await request.json();
  if (type.includes("form")) return Object.fromEntries(await request.formData());
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

// ───────────── Telegram API ─────────────
async function telegram(method, payload) {
  const res = await fetch(`${CONFIG.TELEGRAM_API}/bot${CONFIG.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ""}`);
  }
  return data.result;
}

const sendMessage = (text, extra = {}) =>
  telegram("sendMessage", {
    chat_id: CONFIG.CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });

// ───────────── معالج الإيميل ─────────────
async function handleEmail(request) {
  const url = new URL(request.url);
  if (!safeEqual(url.searchParams.get("key") ?? "", CONFIG.WEBHOOK_SECRET)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const body = await parsePayload(request);

  const from = body.from ?? body.sender ?? body.fromAddress ?? "غير معروف";
  const subject = body.subject ?? "(بدون موضوع)";
  const raw = body.content ?? body.html ?? body.summary ?? body.text ?? "";
  const content = truncate(stripHtml(raw) || "(لا يوجد محتوى)", CONFIG.MAX_BODY_CHARS);

  const message = [
    "🔔 <b>رسالة بريد جديدة</b>",
    "━━━━━━━━━━━━━━",
    `👤 <b>من:</b> ${escapeHtml(from)}`,
    `📌 <b>الموضوع:</b> ${escapeHtml(subject)}`,
    "━━━━━━━━━━━━━━",
    `<blockquote expandable>${escapeHtml(content)}</blockquote>`,
  ].join("\n");

  await sendMessage(message, {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ تمت القراءة", callback_data: "mail_read" }]],
    },
  });

  return json({ ok: true });
}

// ───────────── معالج تيليجرام ─────────────
async function handleTelegram(request) {
  // 1) التأكد أن الطلب قادم فعلاً من تيليجرام
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(secret, CONFIG.WEBHOOK_SECRET)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = await request.json();
  const msg = update.message ?? update.edited_message;
  const cb = update.callback_query;

  // 2) تأكيد الهوية: نقبل فقط صاحب الـ Chat ID
  const senderChatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? "");
  if (senderChatId !== CONFIG.CHAT_ID) {
    return json({ ok: true, ignored: "unauthorized_chat" }); // 200 لمنع إعادة المحاولة
  }

  // 3) أزرار التفاعل
  if (cb) {
    if (cb.data === "mail_read") {
      await telegram("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "تم ✅",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      await telegram("answerCallbackQuery", { callback_query_id: cb.id });
    }
    return json({ ok: true });
  }

  // 4) الأوامر والرسائل النصية
  if (msg?.text) {
    const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    const replies = {
      "/start": "👋 أهلاً مازن! البوت يعمل وسيصلك كل بريد جديد من Zoho هنا.",
      "/ping": "🏓 pong — الـ Worker يعمل بشكل سليم.",
    };
    await sendMessage(replies[cmd] ?? "ℹ️ الأوامر المتاحة: /start ، /ping");
  }

  return json({ ok: true });
}

// ───────────── نقطة الدخول والتوجيه ─────────────
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    try {
      if (request.method === "GET" && pathname === "/") {
        return json({ ok: true, service: "zoho-telegram-bridge" });
      }
      if (request.method === "POST" && pathname === "/webhook/email") {
        return await handleEmail(request);
      }
      if (request.method === "POST" && pathname === "/webhook/telegram") {
        return await handleTelegram(request);
      }
      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      console.error("Worker error:", err.message);
      // 500 للإيميل ليعيد Zoho المحاولة، و200 لتيليجرام لتجنب تكرار التحديثات
      const status = pathname === "/webhook/telegram" ? 200 : 500;
      return json({ ok: false, error: "Internal Error" }, status);
    }
  },
};
