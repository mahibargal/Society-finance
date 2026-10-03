process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
import { loadServerEnv } from "./lib/env.js";

loadServerEnv();
