---
name: invoice
description: Create and optionally send an invoice using Hawk and QuickBooks.
---

Help the user create an invoice via Hawk.

1. Ask the user for: customer name, what they're being billed for, amount, and whether to send it now.
2. Use the `ask_hawk` tool with a message like:
   "Create an invoice for [customer] for [description] at $[amount]. [Send it to their email now / Don't send yet, just save it.]"
3. Report back the invoice number and any confirmation details from Hawk.

If the user wants to look up an existing invoice first, use `list_invoices` or `get_invoice`.
