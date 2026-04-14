---
name: login
description: Log into the Talkative peer network. Handles registration, email verification, and authentication.
---

# Log into the Talkative network

Help the user get onto the network:

1. If they already have saved credentials, call `talk_set_handle` with their email — it will auto-authenticate.
2. If they're new, ask for their email address. Call `talk_set_handle` with the email — the handle is derived automatically (e.g. "arvind.naidu@gmail.com" becomes "@arvindnaidu").
3. Tell the user to check their email and click the verification link. They'll be logged in automatically once they click it.

If "$ARGUMENTS" is provided, treat it as their email (e.g. `/talkative:login arvind@example.com`).

Keep it conversational — this should feel like logging into a chat app, not filling out a form.
