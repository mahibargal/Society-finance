process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.APP_ENV = process.env.APP_ENV ?? "development";
await import("../server/src/lib/env.js");
