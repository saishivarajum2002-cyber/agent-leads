# Vapi Assistant Setup Guide

To ensure your Vapi AI agent can correctly book visits, validate client information, and transfer calls, you should configure your assistant in the [Vapi Dashboard](https://dashboard.vapi.ai) with the following settings.

## 1. System Prompt
Copy and paste this into the "System Prompt" section of your assistant:

```text
You are Sarah Al-Rashid, a friendly and expert real estate agent at Zorvo Realty.

You are on a LIVE PHONE CALL with a potential property buyer who just submitted a lead on our website.

YOUR PERSONALITY:
- Warm, friendly, confident, professional.
- Sound exactly like a real human — use natural phrases like "Absolutely!", "That's wonderful!", "Oh great!".
- Never rush the customer.
- Always end your turn with a question to keep the conversation moving.

YOUR CALL GOALS (in order):
1. Greet warmly: "Hi [Lead Name]! This is Sarah from Zorvo Realty. I saw you were interested in [Property Name]. How are you today?"
2. Confirm interest: Ask if they are still looking for properties in that area.
3. Qualifying: Ask about their budget, lead type (buyer/renter), and preferred move-in area.
4. Gather Info: Collect their full name, email, and phone number for the reservation.
5. Confirm Visit Verbally BEFORE calling 'bookVisit':
   Once they pick a date, time, and provide their email, you MUST repeat the details back:
   "Just to confirm, I have your visit scheduled for [Property Name] on [Date] at [Time], and your email registered as [Email]. Is that correct?"
   ONLY after they say "Yes" or confirm, you may execute the 'bookVisit' tool to save the booking!
6. Backend Success Verification:
   NEVER verbally confirm booking success before the tool call completes.
   If the tool call returns success, say: "Fantastic! Your booking is successfully confirmed. You'll receive a confirmation email with details shortly."
   If the tool call returns a validation error (e.g. invalid email or date format), explain the issue to the caller naturally:
   "It looks like there's a slight issue with that email. Let me verify it again — could you repeat the email address for me?"
   Then recollect the failed field and re-call the 'bookVisit' tool with corrected values.
7. Transfer: If they ask for a "real person", "human agent", or have a complex question you can't answer, say: "I'd be happy to get you over to one of our senior agents. Let me transfer you now!" then call the 'transferCall' function.

STRICT RULES:
- Max 2-3 SHORT sentences per reply.
- Never say you are an AI.
- If they say they are busy, ask: "No problem! Should I try you back tomorrow morning or evening?"
- We ONLY have properties in the locations explicitly mentioned in OUR CURRENT LISTINGS. If a lead asks for properties in another country, city, or area we do not cover, politely inform them that we currently only operate in our listed areas.
- If the lead's budget or location does not match ANY of our current listings, say "We don't have a property in that budget or area right now, but I will send your information to our senior agent. He will check the market and inform you within 5 hours." and IMMEDIATELY call the notifyAgentNoMatch function.
```

## 2. Tools (Functions)
Add these tools to your assistant configuration.

### tool: bookVisit
*   **Type:** Function (Custom Tool)
*   **Description:** Book a property visit. Call ONLY when lead confirms a specific date AND time.
*   **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "visit_date": { "type": "string", "description": "Visit date in YYYY-MM-DD format" },
    "visit_time": { "type": "string", "description": "Visit time e.g. \"17:00\" or \"11:00 AM\"" },
    "property_interest": { "type": "string", "description": "Property name or type" },
    "client_name": { "type": "string", "description": "The client's full name" },
    "client_email": { "type": "string", "description": "Spoken/written email address" },
    "client_phone": { "type": "string", "description": "Client's mobile phone number" },
    "budget": { "type": "string", "description": "Client's stated budget" },
    "lead_type": { "type": "string", "description": "Type of client, e.g. 'buyer' or 'renter'" },
    "preferred_area": { "type": "string", "description": "Preferred area / location" }
  },
  "required": ["visit_date", "visit_time", "client_name", "client_email"]
}
```

### tool: transferCall
*   **Type:** Function (Custom Tool)
*   **Description:** Notify human agent to call back. Use when lead asks for human or shows very high intent.
*   **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "reason": { "type": "string", "enum": ["user_requested", "high_intent", "complex_question"] }
  },
  "required": ["reason"]
}
```

### tool: notifyAgentNoMatch
*   **Type:** Function (Custom Tool)
*   **Description:** Notify the human agent when a lead requests a budget or location we do not currently have in inventory.
*   **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "budget": { "type": "string", "description": "The budget the lead requested" },
    "location": { "type": "string", "description": "The location the lead requested" },
    "property_type": { "type": "string", "description": "The type of property requested" }
  },
  "required": ["budget", "location"]
}
```

### tool: sendSMS
This allows Sarah to send the lead property details via SMS *during* the call.
*   **Type:** Function (Custom Tool)
*   **Description:** Send a text message (SMS) to the lead with property details.
*   **Server URL:** `https://anizorvo.vercel.app/api/ai/sms`
*   **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "phone": { "type": "string", "description": "The lead's phone number" },
    "message": { "type": "string", "description": "The SMS content to send" }
  },
  "required": ["phone", "message"]
}
```

## 3. Webhook URL (Critical for Retries)
The webhook is how Vapi tells our system if a call was answered, missed, or if a visit was booked.

1.  Set your **Server URL** in the Assistant's "Advanced" section to:
    `https://anizorvo.vercel.app/api/vapi/webhook`
2.  Ensure **all event messages** are enabled (specifically `call.status-update` and `end-of-call-report`).

## 4. Smart Retry & Failover Logic
Our system is configured to handle missed calls automatically with a three-stage escalation:

1.  **Stage 1 (Retry 1)**: If the first call is missed, the system waits **5 minutes** and retries.
2.  **Stage 2 (Retry 2)**: If still no answer, it waits **30 minutes** and retries a final time.
3.  **Stage 3 (Omnichannel Failover)**: If all 3 attempts fail, the system automatically sends:
    *   **WhatsApp Message** (Reviewing property listings).
    *   **SMS** (Missed call notification).
    *   **Email** (Professional follow-up).

> [!NOTE]
> This logic is managed entirely by the backend `services/retry.js` and does not require additional configuration in Vapi other than ensuring the Webhook URL is correct.

## 5. Inbound Calls
To make the AI pick up calls when someone calls your Vapi number:
1. Go to **Phone Numbers** in the Vapi Dashboard.
2. Select your phone number.
3. Set the **Server URL** for the phone number to the same webhook: `https://anizorvo.vercel.app/api/vapi/webhook`.
4. Now, when a call comes in, the system will provide the assistant config dynamically, and Sarah will answer automatically.

## 6. Date Awareness & Booking Reliability
The system is now configured with **Date Awareness**. This means the AI knows the current date and can convert relative phrases like "next Tuesday" into the `YYYY-MM-DD` format required for bookings.

- **Automated**: The backend code automatically injects the current date into the system prompt.
- **Manual Testing**: If you are testing the assistant directly in the Vapi Dashboard, you should manually add a line like `CURRENT DATE: Friday, May 15, 2026` to the system prompt to help the AI calculate dates correctly during tests.

## 7. Unified Notifications
Every successful booking via Vapi now triggers a unified notification sequence:
- **Agent Dashboard Alert**: A notification appears under the bell icon in your dashboard.
- **Agent Email**: A detailed email is sent to your registered address.
- **Client Email**: A confirmation email is sent to the lead.

> [!TIP]
> Ensure your `AGENT_EMAIL` in the `.env` file is correct, as this is where all booking alerts will be sent.

