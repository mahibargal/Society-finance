process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.ALLOW_MEMBER_ACTIVATION = "1";
import { loadServerEnv } from "./lib/env.js";

loadServerEnv();
