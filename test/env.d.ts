import type { Env as ShareEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends ShareEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    }

    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

export {};
