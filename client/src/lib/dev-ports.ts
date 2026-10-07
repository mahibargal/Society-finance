/** Local dev only — fixed ports so we do not clash with other Vite (5173) or API (4000) apps. */
export const DEV_CLIENT_PORT = 5187;
export const DEV_API_PORT = 4087;
export const DEV_APP_ORIGIN = `http://127.0.0.1:${DEV_CLIENT_PORT}`;
