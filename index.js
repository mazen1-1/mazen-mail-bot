/**
 * Cloudflare Email Routing  ➜  Telegram Bot  |  Cloudflare Worker (ES Modules)
 *
 * email()                      ← رسائل contact@mazen.design (Email Routing)
 *                                 يرسل إشعاراً + نص الرسالة + المرفقات (صور وملفات) إلى تليجرام،
 *                                 ويحوّل نسخة كاملة إلى Gmail.
 * POST /webhook/telegram       ← تحديثات تيليجرام (زر "تمت القراءة" والأوامر) - اختياري
 * GET  /                       ← Health check
 *
 * Secrets المطلوبة (Runtime):
 *   BOT_TOKEN, CHAT_ID, WEBHOOK_SECRET, GMAIL_DEST
 */

import PostalMime from "postal-mime";

const MAX_BODY_CHARS = 3000;
const MAX_RAW = 15 * 1024 * 1024;        // لا نحلل الرسائل الأكبر من 15MB
const MAX_ATTACHMENTS = 10;              // أقصى عدد مرفقات تُرسل إلى تليجرام
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // حد sendPhoto في تليجرام
const MAX_FILE_BYTES = 50 * 1024 * 1024;  // حد sendDocument للبوتات
const MIN_INLINE_BYTES = 20 * 1024;       // نتجاهل صور التوقيع الصغيرة المضمّنة
const TELEGRAM_API = "https://api.telegram.org";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// ───────────── أدوات مساعدة ─────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

// ينظف المسافات وعلامات الاقتباس من قيم الأسرار
const clean = (v) => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();

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

// فك ترميز عناوين MIME مثل =?UTF-8?B?...?= (احتياط للرسائل الكبيرة)
function decodeMime(str = "") {
  return String(str)
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        let bytes;
        if (enc.toUpperCase() === "B") {
          bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        } else {
          const q = data
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
          bytes = Uint8Array.from(q, (c) => c.charCodeAt(0));
        }
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return data;
      }
    });
}

const formatSize = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

// ───────────── Telegram API ─────────────
async function telegram(env, method, payload) {
  const token = clean(env.BOT_TOKEN);
  if (!token) throw new Error("BOT_TOKEN is empty (secret not reaching the Worker)");

  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
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

// رفع ملف إلى تليجرام (multipart)
async function telegramUpload(env, method, field, { bytes, type, filename }, extra = {}) {
  const token = clean(env.BOT_TOKEN);
  if (!token) throw new Error("BOT_TOKEN is empty (secret not reaching the Worker)");

  const form = new FormData();
  form.append("chat_id", clean(env.CHAT_ID));
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  form.append(field, new Blob([bytes], { type }), filename);

  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ""}`);
  }
  return data.result;
}

const sendMessage = (env, text, extra = {}) =>
  telegram(env, "sendMessage", {
    chat_id: clean(env.CHAT_ID),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });

// إرسال مرفق واحد: صورة إن أمكن، وإلا كملف
async function sendAttachment(env, att, replyToId) {
  const type = (att.mimeType || "application/octet-stream").toLowerCase();
  const bytes =
    typeof att.content === "string" ? new TextEncoder().encode(att.content) : att.content;
  const size = bytes.byteLength;
  const filename = att.filename || `attachment.${type.split("/")[1] || "bin"}`;
  const extra = {
    caption: `📎 ${filename} (${formatSize(size)})`,
    ...(replyToId ? { reply_to_message_id: replyToId } : {}),
  };

  if (size > MAX_FILE_BYTES) {
    await sendMessage(
      env,
      `⚠️ المرفق <code>${escapeHtml(filename)}</code> (${formatSize(size)}) أكبر من حد تليجرام، افتحه من Gmail.`,
      replyToId ? { reply_to_message_id: replyToId } : {}
    );
    return;
  }

  const file = { bytes, type, filename };

  if (PHOTO_TYPES.includes(type) && size <= MAX_PHOTO_BYTES) {
    try {
      await telegramUpload(env, "sendPhoto", "photo", file, extra);
      return;
    } catch (err) {
      // أبعاد غير مقبولة كصورة: نرسلها كملف بدلاً من ذلك
      console.error("sendPhoto failed, falling back to document:", err.message);
    }
  }

  await telegramUpload(env, "sendDocument", "document", file, extra);
}

// ───────────── معالج تيليجرام (اختياري) ─────────────
async function handleTelegram(request, env) {
  // 1) التأكد أن الطلب قادم فعلاً من تيليجرام
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(secret, clean(env.WEBHOOK_SECRET))) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = await request.json();
  const msg = update.message ?? update.edited_message;
  const cb = update.callback_query;

  // 2) نقبل فقط صاحب الـ Chat ID
  const senderChatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? "");
  if (senderChatId !== clean(env.CHAT_ID)) {
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
      let subject = decodeMime(message.headers.get("subject") || "");
      let fromName = "";
      let fromAddr = message.from;
      let content = "(الرسالة كبيرة، افتحها من Gmail)";
      let attachments = [];
      let skippedInline = 0;

      if (message.rawSize <= MAX_RAW) {
        const raw = await new Response(message.raw).arrayBuffer();
        const mail = await PostalMime.parse(raw);
        subject = mail.subject || subject;
        fromName = mail.from?.name || "";
        fromAddr = mail.from?.address || fromAddr;
        content =
          (mail.text || "").trim() || stripHtml(mail.html || "") || "(لا يوجد محتوى)";

        // نتجاهل صور التوقيع الصغيرة المضمّنة (inline) ونرسل الباقي
        for (const att of mail.attachments ?? []) {
          const size = att.content?.byteLength ?? String(att.content ?? "").length;
          if (att.disposition === "inline" && att.contentId && size < MIN_INLINE_BYTES) {
            skippedInline++;
            continue;
          }
          attachments.push(att);
        }
      } else if (message.rawSize > MAX_RAW) {
        content = `(الرسالة كبيرة ${formatSize(message.rawSize)}، افتحها وحمّل مرفقاتها من Gmail)`;
      }

      const toSend = attachments.slice(0, MAX_ATTACHMENTS);
      const fromDisplay = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

      const text = [
        "🔔 <b>رسالة بريد جديدة</b>",
        "━━━━━━━━━━━━━━",
        `👤 <b>من:</b> ${escapeHtml(fromDisplay)}`,
        `📬 <b>إلى:</b> ${escapeHtml(message.to)}`,
        `📌 <b>الموضوع:</b> ${escapeHtml(subject || "(بدون موضوع)")}`,
        attachments.length ? `📎 <b>مرفقات:</b> ${attachments.length}` : null,
        "━━━━━━━━━━━━━━",
        `<blockquote expandable>${escapeHtml(truncate(content, MAX_BODY_CHARS))}</blockquote>`,
      ]
        .filter((l) => l !== null)
        .join("\n");

      const sent = await sendMessage(env, text, {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ تمت القراءة", callback_data: "mail_read" }]],
        },
      });

      // المرفقات تصل كردود على الإشعار
      for (const att of toSend) {
        try {
          await sendAttachment(env, att, sent?.message_id);
        } catch (err) {
          console.error("attachment failed:", att.filename, err.message);
          await sendMessage(
            env,
            `⚠️ تعذّر إرسال المرفق <code>${escapeHtml(att.filename || "attachment")}</code>، افتحه من Gmail.`,
            sent?.message_id ? { reply_to_message_id: sent.message_id } : {}
          ).catch(() => {});
        }
      }

      if (attachments.length > MAX_ATTACHMENTS) {
        await sendMessage(
          env,
          `ℹ️ أُرسل أول ${MAX_ATTACHMENTS} مرفقات فقط من ${attachments.length}، والباقي في Gmail.`
        ).catch(() => {});
      }
    } catch (err) {
      console.error("Email error:", err.message);
    }

    // تصل نسخة كاملة (بكل المرفقات) إلى Gmail حتى لو فشل تليجرام
    try {
      await message.forward(clean(env.GMAIL_DEST));
    } catch (err) {
      console.error("forward failed:", err.message);
      throw err;
    }
  },
};
