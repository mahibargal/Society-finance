# Client visual flow guide

Interactive **step-by-step walkthrough** with **Mermaid diagrams** and **real app screenshots** for client demos.

## Open the guide

1. Ensure the app has been built and run at least once (`npm run build -w client`, `npm run start -w server`).
2. Open in a browser (double-click or drag into Chrome/Edge):

   **`docs/client-flow-guide/index.html`**

Use **Print → Save as PDF** to send a static deck to the client.

## Refresh screenshots

After UI changes or new demo data:

```bash
npm run build -w client
npm run start -w server
node docs/scripts/capture-flow-screenshots.mjs
```

Optional env (defaults: first active staff/member in DB):

- `SCREENSHOT_STAFF_USER` — staff username
- `SCREENSHOT_MEMBER_USER` — member username
- `BASE_URL` — default `http://127.0.0.1:4000`

The capture script signs in via the database (no password spam / rate limits).

## Related

- Text HLD: [../CLIENT-HLD-FLOW.md](../CLIENT-HLD-FLOW.md)
