---
name: shadow
description: Shadow a peer's tools and get set up with the same MCP servers and capabilities they have. Use when the user wants to copy another team member's tool setup.
---

# Shadow a peer

The user wants to shadow another peer's tools. Use the `talk_peers` tool to see who's online, then use `talk_send` to ask the target peer what tools they have configured.

If "$ARGUMENTS" is provided, treat it as the peer handle to shadow (e.g. `/talkative:shadow @sarah`).

Compare their tools to yours using `talk_my_tools`, identify the gaps, and walk the user through installing each missing tool. Ask for credentials locally — never send them over the network.
