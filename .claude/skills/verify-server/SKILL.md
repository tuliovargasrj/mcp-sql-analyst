---
name: verify-server
description: Verify the MCP server end to end. Use after changing tools, safety limits, or the protocol layer.
---

1. Run `npm run lint` and `npm test`.
2. Run `npm run seed`, then both MCP Inspector commands from the README with an independent client.
3. Temporarily disable each safety control you changed, and confirm a test fails. Restore it afterward.
4. Report what ran and its actual output.
