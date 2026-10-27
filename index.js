/**
 * Cloudflare Email Routing  ➜  Telegram Bot  |  Cloudflare Worker (ES Modules)
 *
 * email()                      ← رسائل contact@mazen.design (Email Routing)
 * POST /webhook/telegram       ← تحديثات تيليجرام (الأزرار والأوامر)
 * GET  /                       ← Health check
 *
 * كل القيم الحساسة تأتي من Secrets (env) وليست مكتوبة في الكود:
 *   BOT_TOKEN, CHAT_ID, WEBHOOK_SECRET, GMAIL_DEST
 */

import PostalMime from "postal-mime";

const MAX_BODY_CHARS = 3000;
const MAX_RAW = 5 * 1024 * 1024; // لا نحلل الرسائل الأكبر من 5MB
const TELEGRAM_API = "https://api.telegram.org";

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

// ───────────── Telegram API ─────────────
async function telegram(env, method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
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

const sendMessage = (env, text, extra = {}) =>
  telegram(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });

// ───────────── معالج تيليجرام ─────────────
async function handleTelegram(request, env) {
  // 1) التأكد أن الطلب قادم فعلاً من تيليجرام
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(secret, env.WEBHOOK_SECRET ?? "")) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = await request.json();
  const msg = update.message ?? update.edited_message;
  const cb = update.callback_query;

  // 2) نقبل فقط صاحب الـ Chat ID
  const senderChatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? "");
  if (senderChatId !== String(env.CHAT_ID)) {
    return json({ ok: true, ignored: "unauthorized_chat" });
  }

  // 3) أزرار التفاعل
  if (cb) {
    if (cb.data === "mail_read") {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "تم ✅",
      });
      await telegram(env, "editMessageReplyMarkup", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      await telegram(env, "answerCallbackQuery", { callback_query_id: cb.id });
    }
    return json({ ok: true });
  }

  // 4) الأوامر
  if (msg?.text) {
    const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    const replies = {
      "/start": "👋 أهلاً مازن! البوت يعمل وسيصلك كل بريد جديد على contact@mazen.design هنا.",
      "/ping": "🏓 pong — الـ Worker يعمل بشكل سليم.",
    };
    await sendMessage(env, replies[cmd] ?? "ℹ️ الأوامر المتاحة: /start ، /ping");
  }

  return json({ ok: true });
}

// ───────────── نقطة الدخول ─────────────
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/") {
        return json({ ok: true, service: "mazen-mail-bot" });
      }
      if (request.method === "POST" && pathname === "/webhook/telegram") {
        return await handleTelegram(request, env);
      }
      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      console.error("Worker error:", err.message);
      // 200 لتجنب تكرار التحديثات من تيليجرام
      return json({ ok: false, error: "Internal Error" }, 200);
    }
  },

  // رسائل Cloudflare Email Routing
  async email(message, env) {
    try {
      const subject = message.headers.get("subject") || "(بدون موضوع)";
      let content = "(الرسالة كبيرة، افتحها من Gmail)";
      let attachments = 0;

      if (message.rawSize <= MAX_RAW) {
        const raw = await new Response(message.raw).arrayBuffer();
        const mail = await PostalMime.parse(raw);
        content =
          (mail.text || "").trim() || stripHtml(mail.html || "") || "(لا يوجد محتوى)";
        attachments = mail.attachments?.length ?? 0;
      }

      const text = [
        "🔔 <b>رسالة بريد جديدة</b>",
        "━━━━━━━━━━━━━━",
        `👤 <b>من:</b> ${escapeHtml(message.from)}`,
        `📬 <b>إلى:</b> ${escapeHtml(message.to)}`,
        `📌 <b>الموضوع:</b> ${escapeHtml(subject)}`,
        attachments ? `📎 <b>مرفقات:</b> ${attachments}` : null,
        "━━━━━━━━━━━━━━",
        `<blockquote expandable>${escapeHtml(truncate(content, MAX_BODY_CHARS))}</blockquote>`,
      ]
        .filter(Boolean)
        .join("\n");

      await sendMessage(env, text, {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ تمت القراءة", callback_data: "mail_read" }]],
        },
      });
    } catch (err) {
      console.error("Email error:", err.message);
    }

    // تصل نسخة إلى Gmail حتى لو فشل تليجرام
    await message.forward(env.GMAIL_DEST);
  },
};
