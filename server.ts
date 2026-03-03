import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import { format, addMinutes, isBefore, parseISO } from "date-fns";
import session from "express-session";

console.log("[Assist Ai] Starting server initialization...");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("assist_ai.db");

// --- Database Initialization ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    otp TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT NOT NULL,
    first_reminder_at TEXT,
    status TEXT DEFAULT 'pending',
    urgency TEXT DEFAULT 'normal',
    channels TEXT DEFAULT 'push',
    repeat_interval_minutes INTEGER DEFAULT 0,
    repeat_count INTEGER DEFAULT 999,
    current_repeat_count INTEGER DEFAULT 0,
    aggressive_mode INTEGER DEFAULT 0,
    last_notified_at TEXT,
    next_notification_due_at TEXT,
    is_overdue INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER,
    channel TEXT,
    message_type TEXT,
    message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivery_status TEXT DEFAULT 'sent',
    error_message TEXT,
    FOREIGN KEY(reminder_id) REFERENCES reminders(id)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    phone_number TEXT,
    whatsapp_number TEXT,
    trusted_contact_phone TEXT,
    default_channels TEXT DEFAULT 'push',
    aggressive_mode_enabled INTEGER DEFAULT 0,
    accountability_mode_enabled INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// --- Twilio Setup ---
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// --- Notification Service ---
const TEMPLATES = {
  whatsapp: {
    initial: (data: any) => `🤖 Assist Ai Reminder\n\n📌 Event: ${data.title}\n📅 Event Date: ${data.dateStr}\n⏰ Event Time: ${data.timeStr}\n\n🔔 First Reminder At: ${data.firstReminderStr}\n\n⚡ Status: Pending\nPlease complete your task on time.\n\nReply:\n1️⃣ DONE – Mark as completed\n2️⃣ SNOOZE – Remind later\n🔁 Repeating Reminder (Based on Gap)\n\n(Triggered every ${data.gap} until marked complete)`,
    followup: (data: any) => `🚨 Assist Ai Follow-Up Reminder\n\n📌 Event: ${data.title}\n⏰ Scheduled Time: ${data.dateStr} at ${data.timeStr}\n\n🔁 Reminder Interval: Every ${data.gap}\n📍 Current Status: Still Pending\n\n⚠️ Don’t miss your deadline!\nReply DONE to stop reminders.`,
    overdue: (data: any) => `❗ Assist Ai – Task Overdue\n\n📌 Event: ${data.title}\n⏰ Was Scheduled For: ${data.dateStr} at ${data.timeStr}\n\n🚨 You are past the deadline.\n🔁 Reminding you every ${data.gap} until completed.\n\nReply DONE to mark complete.`,
    accountability: (data: any) => `🚨 [Assist Ai Accountability]\n\nYour contact missed a CRITICAL deadline:\n📌 Event: ${data.title}\n⏰ Scheduled For: ${data.dateStr} at ${data.timeStr}\n\nPlease check in on them.`
  },
  sms: {
    initial: (data: any) => `Assist Ai Reminder\n\nEvent: ${data.title}\nDate: ${data.dateStrSMS}\nTime: ${data.timeStr}\n\nFirst Reminder: ${data.firstReminderStr}\nStatus: Pending\n\nReply DONE to complete.`,
    followup: (data: any) => `Assist Ai Follow-Up\n\nEvent: ${data.title}\nScheduled: ${data.dateStrSMS} at ${data.timeStr}\n\nStill Pending.\nReminder Interval: Every ${data.gap}\n\nReply DONE to stop alerts.`,
    overdue: (data: any) => `Assist Ai ALERT\n\nEvent: ${data.title}\nWas Scheduled: ${data.dateStrSMS} at ${data.timeStr}\n\nTask is OVERDUE.\nReminding every ${data.gap} until marked DONE.\n\nReply DONE to complete.`,
    aggressive: (data: any) => `Assist Ai URGENT\n\n${data.title} is pending.\nScheduled: ${data.dateStrSMS} ${data.timeStr}\n\nYou are overdue.\nReminding every ${data.gap}.\n\nReply DONE now.`,
    accountability: (data: any) => `Assist Ai Accountability\n\nYour contact missed a CRITICAL deadline: ${data.title} at ${data.dateStrSMS} ${data.timeStr}. Please check in.`
  }
};

function buildMessage(channel: string, stage: string, reminder: any, aggressive: boolean) {
  const eventDate = parseISO(reminder.due_date);
  const firstReminderAt = reminder.first_reminder_at ? parseISO(reminder.first_reminder_at) : eventDate;
  
  const data = {
    title: reminder.title,
    dateStr: format(eventDate, 'MMM d, yyyy'),
    dateStrSMS: format(eventDate, 'dd/MM/yyyy'),
    timeStr: format(eventDate, 'h:mm a'),
    firstReminderStr: format(firstReminderAt, 'MMM d, h:mm a'),
    gap: reminder.repeat_interval_minutes > 0 ? `${reminder.repeat_interval_minutes} min` : 'None'
  };

  if (channel === 'whatsapp') {
    const template = (TEMPLATES.whatsapp as any)[stage];
    return template ? template(data) : `Assist Ai: ${reminder.title} is pending.`;
  } else {
    let templateKey = stage;
    if (stage === 'overdue' && aggressive) templateKey = 'aggressive';
    const template = (TEMPLATES.sms as any)[templateKey];
    return template ? template(data) : `Assist Ai: ${reminder.title} is pending.`;
  }
}

async function sendTwilioMessage(channel: string, to: string, body: string, retryCount = 0): Promise<{ success: boolean, error?: string }> {
  if (!twilioClient) return { success: false, error: "Twilio client not initialized. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." };
  
  // Ensure phone numbers are in E.164 format (starting with +)
  const formatPhone = (num: string) => {
    const cleaned = num.trim();
    if (!cleaned.startsWith('+')) {
      return `+${cleaned}`;
    }
    return cleaned;
  };

  const formattedTo = formatPhone(to);
  const fromNumber = channel === 'sms' ? process.env.TWILIO_PHONE_NUMBER : process.env.TWILIO_WHATSAPP_NUMBER;
  
  if (!fromNumber) {
    const err = `Missing 'From' number for ${channel}. Please set ${channel === 'sms' ? 'TWILIO_PHONE_NUMBER' : 'TWILIO_WHATSAPP_NUMBER'}.`;
    console.error(`[Twilio Error] ${err}`);
    return { success: false, error: err };
  }

  const formattedFrom = formatPhone(fromNumber);

  try {
    let msgResult;
    if (channel === 'sms') {
      msgResult = await twilioClient.messages.create({
        body,
        from: formattedFrom,
        to: formattedTo
      });
    } else {
      msgResult = await twilioClient.messages.create({
        body,
        from: `whatsapp:${formattedFrom}`,
        to: `whatsapp:${formattedTo.replace('whatsapp:', '')}`
      });
    }
    console.log(`[Twilio Success] ${channel} to ${formattedTo} — SID: ${msgResult.sid}, Status: ${msgResult.status}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Twilio Error] Attempt ${retryCount + 1} failed for ${channel}:`, error.message || error);
    if (retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return sendTwilioMessage(channel, to, body, retryCount + 1);
    }
    return { success: false, error: error.message || "Unknown Twilio error" };
  }
}

// --- Notification Queue & Rate Limiting ---
interface QueuedNotification {
  reminder: any;
  channel: string;
  stage: 'initial' | 'followup' | 'overdue' | 'accountability';
}

const notificationQueue: QueuedNotification[] = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) return;
  isProcessingQueue = true;

  while (notificationQueue.length > 0) {
    const item = notificationQueue.shift();
    if (item) {
      await executeNotification(item.reminder, item.channel, item.stage);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  isProcessingQueue = false;
}

async function sendNotification(reminder: any, channel: string, stage: 'initial' | 'followup' | 'overdue' | 'accountability' = 'initial') {
  notificationQueue.push({ reminder, channel, stage });
  // Don't await — fire and forget, but ensure it starts processing
  processQueue().catch(err => console.error('[Queue Error]', err));
}

async function executeNotification(reminder: any, channel: string, stage: 'initial' | 'followup' | 'overdue' | 'accountability' = 'initial') {
  const settings = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(reminder.user_id) as any;
  
  let target = '';
  if (stage === 'accountability') {
    target = settings?.trusted_contact_phone || '';
  } else {
    target = channel === 'sms' ? (settings?.phone_number || '') : (settings?.whatsapp_number || '');
  }

  const message = buildMessage(channel === 'push' ? 'sms' : channel, stage, reminder, !!reminder.aggressive_mode);

  // If channel is 'push', always log it as sent (consumed by frontend polling)
  if (channel === 'push') {
    console.log(`[Notification] In-app push for reminder ${reminder.id}: ${reminder.title}`);
    db.prepare(`
      INSERT INTO notification_logs (reminder_id, channel, message_type, message, delivery_status, error_message) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reminder.id, 'push', stage, message, 'sent', '');
    return;
  }

  // For SMS/WhatsApp: skip silently if no target number configured
  if (!target) {
    const errMsg = `No ${channel} number configured in user settings`;
    console.warn(`[Notification] Skipping ${channel} for reminder ${reminder.id}: ${errMsg}`);
    db.prepare(`
      INSERT INTO notification_logs (reminder_id, channel, message_type, message, delivery_status, error_message) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reminder.id, channel, stage, message, 'failed', errMsg);
    return;
  }

  console.log(`[Notification] Sending via ${channel} to ${target} [Stage: ${stage}]: ${message}`);

  let success = false;
  let errorMsg = '';
  const result = await sendTwilioMessage(channel, target, message);
  success = result.success;
  errorMsg = result.error || '';
  if (!success && channel === 'whatsapp' && settings?.phone_number) {
    console.log(`[Notification Fallback] WhatsApp failed, trying SMS for reminder ${reminder.id}`);
    const smsMessage = buildMessage('sms', stage, reminder, !!reminder.aggressive_mode);
    const fallbackResult = await sendTwilioMessage('sms', settings.phone_number, smsMessage);
    success = fallbackResult.success;
    errorMsg = fallbackResult.error || errorMsg;
    if (success) channel = 'sms (fallback)';
  }
  if (!success) errorMsg = errorMsg || 'Twilio delivery failed after retries';

  db.prepare(`
    INSERT INTO notification_logs (reminder_id, channel, message_type, message, delivery_status, error_message) 
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(reminder.id, channel, stage, message, success ? 'sent' : 'failed', errorMsg);
}

// --- Scheduler Engine ---
async function checkReminders() {
  try {
    const now = new Date();
    const reminders = db.prepare("SELECT * FROM reminders WHERE status = 'pending'").all() as any[];

    for (const reminder of reminders) {
      const dueDate = parseISO(reminder.due_date);
      const firstReminderAt = reminder.first_reminder_at ? parseISO(reminder.first_reminder_at) : dueDate;
      const nextDue = reminder.next_notification_due_at ? parseISO(reminder.next_notification_due_at) : firstReminderAt;

      if (isBefore(nextDue, now)) {
        let stage: 'initial' | 'followup' | 'overdue' = 'initial';
        let isOverdue = isBefore(dueDate, now);
        
        if (!reminder.last_notified_at) {
          stage = 'initial';
        } else if (isOverdue) {
          stage = 'overdue';
        } else {
          stage = 'followup';
        }

        const channels = (reminder.channels || '').split(',').map((c: string) => c.trim()).filter(Boolean);
        for (const channel of channels) {
          await sendNotification(reminder, channel, stage);
        }

        const gap = reminder.repeat_interval_minutes || 60;
        const aggressiveGap = reminder.aggressive_mode ? Math.min(gap, 5) : gap;
        const nextGap = isOverdue ? aggressiveGap : gap;
        const nextNotificationTime = addMinutes(now, nextGap);

        db.prepare(`
          UPDATE reminders 
          SET last_notified_at = ?, 
              next_notification_due_at = ?, 
              current_repeat_count = current_repeat_count + 1,
              is_overdue = ?
          WHERE id = ?
        `).run(now.toISOString(), nextNotificationTime.toISOString(), isOverdue ? 1 : 0, reminder.id);

        if (isOverdue && reminder.urgency === 'critical' && isBefore(addMinutes(dueDate, 30), now)) {
          const settings = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(reminder.user_id) as any;
          if (settings?.accountability_mode_enabled) {
            await sendNotification(reminder, 'sms', 'accountability');
          }
        }
      }
    }
  } catch (error) {
    console.error("[Assist Ai] Scheduler Error:", error);
  }
}

// Clear any previous scheduler and start fresh
if ((global as any)._schedulerInterval) {
  clearInterval((global as any)._schedulerInterval);
}
(global as any)._schedulerInterval = setInterval(checkReminders, 30000);
console.log("[Assist Ai] Scheduler started successfully");
// Run immediately on startup
checkReminders();

// --- Express App ---
async function startServer() {
  try {
    const app = express();
    app.use(express.json());
    app.use(session({
      secret: process.env.SESSION_SECRET || 'assist-ai-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      }
    }));

    // --- Auth Middleware ---
    const requireAuth = (req: any, res: any, next: any) => {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      next();
    };

    // --- Auth Routes ---
    app.post("/api/auth/send-otp", async (req, res) => {
      const { phone_number } = req.body;
      if (!phone_number) return res.status(400).json({ error: "Phone number required" });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = addMinutes(new Date(), 10).toISOString();

      db.prepare("INSERT INTO otps (phone_number, otp, expires_at) VALUES (?, ?, ?)").run(phone_number, otp, expiresAt);

      console.log(`[Auth] OTP for ${phone_number}: ${otp}`);

      let delivered = false;
      let error = null;

      if (twilioClient) {
        const result = await sendTwilioMessage('sms', phone_number, `Assist Ai: Your login code is ${otp}. Valid for 10 minutes.`);
        delivered = result.success;
        error = result.error;
      } else {
        error = "Twilio not configured. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Secrets.";
      }

      res.json({ 
        success: delivered, 
        message: delivered ? "OTP sent successfully" : "OTP could not be sent via SMS",
        error: error,
        otp: process.env.NODE_ENV !== 'production' ? otp : null,
        dev_hint: process.env.NODE_ENV !== 'production' ? "Check server logs or the toast below for the code" : null
      });
    });

    app.post("/api/auth/verify-otp", (req, res) => {
      const { phone_number, otp } = req.body;
      if (!phone_number || !otp) return res.status(400).json({ error: "Phone and OTP required" });

      const record = db.prepare("SELECT * FROM otps WHERE phone_number = ? AND otp = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
        .get(phone_number, otp, new Date().toISOString()) as any;

      if (!record) return res.status(400).json({ error: "Invalid or expired OTP" });

      let user = db.prepare("SELECT * FROM users WHERE phone_number = ?").get(phone_number) as any;
      if (!user) {
        const info = db.prepare("INSERT INTO users (phone_number) VALUES (?)").run(phone_number);
        user = { id: info.lastInsertRowid, phone_number };
        db.prepare("INSERT INTO user_settings (user_id, phone_number) VALUES (?, ?)").run(user.id, phone_number);
      }

      (req.session as any).userId = user.id;
      res.json({ success: true, user });
    });

    app.get("/api/auth/me", (req: any, res) => {
      if (!req.session.userId) return res.json({ user: null });
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
      res.json({ user });
    });

    app.get("/api/config/status", requireAuth, (req, res) => {
      res.json({
        twilio: {
          configured: !!twilioClient,
          sms_number: process.env.TWILIO_PHONE_NUMBER ? `${process.env.TWILIO_PHONE_NUMBER.slice(0, 3)}...${process.env.TWILIO_PHONE_NUMBER.slice(-4)}` : null,
          whatsapp_number: process.env.TWILIO_WHATSAPP_NUMBER ? `${process.env.TWILIO_WHATSAPP_NUMBER.slice(0, 3)}...${process.env.TWILIO_WHATSAPP_NUMBER.slice(-4)}` : null,
          has_sid: !!process.env.TWILIO_ACCOUNT_SID,
          has_token: !!process.env.TWILIO_AUTH_TOKEN
        },
        gemini: {
          configured: !!process.env.GEMINI_API_KEY
        }
      });
    });

    app.post("/api/auth/logout", (req, res) => {
      req.session.destroy(() => {
        res.json({ success: true });
      });
    });

    app.post("/api/parse", requireAuth, async (req: any, res) => {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: "Text required" });

      if (!process.env.GEMINI_API_KEY) {
        // Fallback parsing if Gemini is not configured
        const now = new Date();
        return res.json({
          title: text.substring(0, 50),
          description: text,
          due_date: addMinutes(now, 60).toISOString(),
          first_reminder_at: addMinutes(now, 45).toISOString(),
          urgency: 'normal',
          channels: ['push'],
          isFallback: true
        });
      }

      try {
        const { GoogleGenAI } = await import("@google/genai");
        const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const prompt = `
          Extract reminder details from this text: "${text}"
          Current time: ${new Date().toISOString()}
          
          Return ONLY a JSON object with:
          - title: string
          - description: string
          - due_date: ISO string
          - first_reminder_at: ISO string (usually 15-30 mins before due_date)
          - urgency: "low" | "normal" | "high" | "critical"
          - channels: string[] (choices: "push", "sms", "whatsapp")
          
          If time is not specified, default to 1 hour from now.
        `;

        const response = await genAI.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: prompt,
          config: { responseMimeType: "application/json" }
        });

        const result = JSON.parse(response.text || "{}");
        res.json({ ...result, isFallback: false });
      } catch (err) {
        console.error("Gemini Parse Error:", err);
        // Fallback on error
        const now = new Date();
        res.json({
          title: text.substring(0, 50),
          description: text,
          due_date: addMinutes(now, 60).toISOString(),
          first_reminder_at: addMinutes(now, 45).toISOString(),
          urgency: 'normal',
          channels: ['push'],
          isFallback: true
        });
      }
    });

    // --- API Routes ---
    app.get("/api/health", (req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    // Force-trigger the scheduler and optionally reset pending notification timers
    app.post("/api/admin/trigger-scheduler", async (req, res) => {
      try {
        // Reset next_notification_due_at for all pending reminders so they fire now
        db.prepare("UPDATE reminders SET next_notification_due_at = ? WHERE status = 'pending'")
          .run(new Date(Date.now() - 60000).toISOString());
        await checkReminders();
        res.json({ success: true, message: "Scheduler triggered, pending reminders reset." });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/reminders", requireAuth, (req: any, res) => {
      try {
        const reminders = db.prepare("SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date ASC").all(req.session.userId);
        res.json(reminders);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch reminders" });
      }
    });

    app.post("/api/reminders", requireAuth, (req: any, res) => {
      try {
        const { title, description, due_date, first_reminder_at, urgency, channels, repeat_interval_minutes, repeat_count, aggressive_mode } = req.body;
        const info = db.prepare(`
          INSERT INTO reminders (user_id, title, description, due_date, first_reminder_at, urgency, channels, repeat_interval_minutes, repeat_count, aggressive_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, title, description, due_date, first_reminder_at, urgency || 'normal', channels || 'push', repeat_interval_minutes || 0, repeat_count || 999, aggressive_mode ? 1 : 0);
        res.json({ id: info.lastInsertRowid });
      } catch (err) {
        res.status(500).json({ error: "Failed to create reminder" });
      }
    });

    app.patch("/api/reminders/:id", requireAuth, (req: any, res) => {
      try {
        const { status, last_notified_at, snooze_minutes } = req.body;
        const reminder = db.prepare("SELECT * FROM reminders WHERE id = ? AND user_id = ?").get(req.params.id, req.session.userId) as any;
        if (!reminder) return res.status(404).json({ error: "Not found" });

        if (status) {
          db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(status, req.params.id);
        }
        if (last_notified_at) {
          db.prepare("UPDATE reminders SET last_notified_at = ? WHERE id = ?").run(last_notified_at, req.params.id);
        }
        if (snooze_minutes) {
          const newDueDate = addMinutes(parseISO(reminder.due_date), snooze_minutes).toISOString();
          db.prepare("UPDATE reminders SET due_date = ?, status = 'pending', last_notified_at = NULL WHERE id = ?").run(newDueDate, req.params.id);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to update reminder" });
      }
    });

    app.delete("/api/reminders/:id", requireAuth, (req: any, res) => {
      try {
        db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to delete reminder" });
      }
    });

    app.get("/api/notifications", requireAuth, (req: any, res) => {
      try {
        const notifications = db.prepare(`
          SELECT nl.*, r.title as reminder_title 
          FROM notification_logs nl
          JOIN reminders r ON nl.reminder_id = r.id
          WHERE r.user_id = ?
          ORDER BY nl.sent_at DESC 
          LIMIT 100
        `).all(req.session.userId);
        res.json(notifications);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch notifications" });
      }
    });

    app.get("/api/settings", requireAuth, (req: any, res) => {
      try {
        const settings = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.session.userId);
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch settings" });
      }
    });

    app.patch("/api/settings", requireAuth, (req: any, res) => {
      try {
        const { phone_number, whatsapp_number, trusted_contact_phone, default_channels, aggressive_mode_enabled, accountability_mode_enabled } = req.body;
        db.prepare(`
          UPDATE user_settings 
          SET phone_number = ?, whatsapp_number = ?, trusted_contact_phone = ?, default_channels = ?, aggressive_mode_enabled = ?, accountability_mode_enabled = ?
          WHERE user_id = ?
        `).run(phone_number, whatsapp_number, trusted_contact_phone, default_channels, aggressive_mode_enabled ? 1 : 0, accountability_mode_enabled ? 1 : 0, req.session.userId);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to update settings" });
      }
    });

    app.get("/api/config-status", (req, res) => {
      res.json({
        twilio: {
          configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
          sms_enabled: !!process.env.TWILIO_PHONE_NUMBER,
          whatsapp_enabled: !!process.env.TWILIO_WHATSAPP_NUMBER
        },
        gemini: {
          configured: !!process.env.GEMINI_API_KEY
        }
      });
    });

    app.get("/api/analytics", requireAuth, (req: any, res) => {
      try {
        const total = db.prepare("SELECT COUNT(*) as count FROM reminders WHERE user_id = ?").get(req.session.userId) as any;
        const completed = db.prepare("SELECT COUNT(*) as count FROM reminders WHERE user_id = ? AND status = 'completed'").get(req.session.userId) as any;
        const urgencyDist = db.prepare("SELECT urgency, COUNT(*) as count FROM reminders WHERE user_id = ? GROUP BY urgency").all(req.session.userId);
        const recentNotifications = db.prepare("SELECT COUNT(*) as count FROM notification_logs nl JOIN reminders r ON nl.reminder_id = r.id WHERE r.user_id = ? AND nl.sent_at > datetime('now', '-24 hours')").get(req.session.userId) as any;
        const failedNotifications = db.prepare("SELECT COUNT(*) as count FROM notification_logs nl JOIN reminders r ON nl.reminder_id = r.id WHERE r.user_id = ? AND nl.delivery_status = 'failed'").get(req.session.userId) as any;

        res.json({
          total: total.count,
          completed: completed.count,
          completion_rate: total.count > 0 ? (completed.count / total.count) * 100 : 0,
          urgency_distribution: urgencyDist,
          notifications_24h: recentNotifications.count,
          failed_total: failedNotifications.count
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch analytics" });
      }
    });

    // --- Twilio Webhook (for DONE/SNOOZE replies from users) ---
    app.post("/webhook/twilio", express.urlencoded({ extended: false }), async (req, res) => {
      try {
        const { Body, From } = req.body;
        const message = (Body || '').trim().toUpperCase();
        const rawPhone = (From || '').replace('whatsapp:', '');
        const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;

        const user = db.prepare("SELECT id FROM users WHERE phone_number = ? OR phone_number = ?")
          .get(phone, phone.replace('+', '')) as any;

        let replyMsg = '';
        if (!user) {
          replyMsg = 'Assist Ai: Phone number not registered.';
        } else if (message === 'DONE' || message === '1') {
          const reminder = db.prepare("SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY next_notification_due_at ASC LIMIT 1")
            .get(user.id) as any;
          if (reminder) {
            db.prepare("UPDATE reminders SET status = 'completed' WHERE id = ?").run(reminder.id);
            replyMsg = `✅ Assist Ai: "${reminder.title}" marked as completed. Great work!`;
            console.log(`[Webhook] Reminder ${reminder.id} completed via reply from ${phone}`);
          } else {
            replyMsg = 'Assist Ai: No pending tasks found.';
          }
        } else if (message === 'SNOOZE' || message === '2') {
          const reminder = db.prepare("SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY next_notification_due_at ASC LIMIT 1")
            .get(user.id) as any;
          if (reminder) {
            const newTime = addMinutes(new Date(), 15).toISOString();
            db.prepare("UPDATE reminders SET next_notification_due_at = ? WHERE id = ?").run(newTime, reminder.id);
            replyMsg = `⏰ Assist Ai: "${reminder.title}" snoozed for 15 minutes.`;
            console.log(`[Webhook] Reminder ${reminder.id} snoozed via reply from ${phone}`);
          } else {
            replyMsg = 'Assist Ai: No pending tasks to snooze.';
          }
        } else {
          replyMsg = 'Assist Ai Help:\n\nReply DONE (or 1) to complete your task.\nReply SNOOZE (or 2) to delay by 15 minutes.';
        }

        const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyMsg}</Message></Response>`;
        res.type('text/xml').send(twiml);
      } catch (err) {
        console.error('[Webhook] Error:', err);
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }
    });

    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      app.use(express.static(path.join(__dirname, "dist")));
      app.get("*", (req, res, next) => {
        if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/")) return next();
        res.sendFile(path.join(__dirname, "dist", "index.html"));
      });
    }

    const PORT = parseInt(process.env.PORT || "3000", 10);
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Assist Ai] Server started successfully`);
      console.log(`[Assist Ai] Database connected`);
      console.log(`[Assist Ai] Running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("[Assist Ai] Critical Server Startup Error:", error);
  }
}

startServer();
