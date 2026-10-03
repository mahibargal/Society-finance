import type { AuthUser } from "../middleware/auth.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
      cookies?: Record<string, string>;
    }
  }
}

export {};
