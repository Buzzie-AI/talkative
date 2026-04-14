---
name: login
description: Log into the Talkative peer network. Handles registration, email verification, and authentication.
---

# Log into the Talkative network

Help the user get onto the network:

1. If they already have saved credentials, call `talk_set_handle` with just their handle — it will auto-authenticate.
2. If they're new or don't have credentials, ask for their preferred handle (e.g. "@sarah") and email address. Call `talk_set_handle` with both.
3. If a verification code is needed, ask the user to check their email and provide the 6-digit code. Call `talk_verify` with the code.

If "$ARGUMENTS" is provided, treat it as their handle (e.g. `/talkative:login @arvind`).

Keep it conversational — this should feel like logging into a chat app, not filling out a form.
