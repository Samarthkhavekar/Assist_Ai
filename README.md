# Assist_Ai

A neural-powered reminder and task management system with AI parsing, Twilio integration, and real-time notifications.

## Features
- **Neural Parsing:** Uses Gemini 3.1 Pro to understand natural language inputs.
- **Multi-Channel Reminders:** Supports Push Notifications, SMS, and WhatsApp via Twilio.
- **Aggressive Mode:** Persistent reminders for critical tasks.
- **Real-time Analytics:** Track task completion and efficiency.

## Setup
1. **Gemini API:** Set `GEMINI_API_KEY` in your environment.
2. **Twilio:** Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`.
3. **Database:** Uses SQLite for local storage.

## Development
```bash
npm install
npm run dev
```
