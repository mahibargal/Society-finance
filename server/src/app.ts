import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { errorHandler } from "./lib/http.js";
import { api } from "./routes/api.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    helmet({
      strictTransportSecurity: process.env.NODE_ENV === "production",
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
        },
      },
    }),
  );
  const clientOrigins = (process.env.CLIENT_ORIGIN ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: clientOrigins.length > 0 ? clientOrigins : true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const uploads = path.resolve("uploads");
  fs.mkdirSync(uploads, { recursive: true });
  app.use("/uploads", express.static(uploads));
  app.use("/api", api);
  const client = path.resolve("../client/dist");
  if (fs.existsSync(path.join(client, "index.html"))) {
    app.use(express.static(client));
    app.get(/^(?!\/api|\/uploads).*/, (_req, res) => {
      res.sendFile(path.join(client, "index.html"));
    });
  }
  app.use(errorHandler);
  return app;
}
