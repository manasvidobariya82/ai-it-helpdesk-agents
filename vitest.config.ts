import { defineConfig } from "vitest/config";
import path from "node:path";

const r = (p: string) => path.resolve(process.cwd(), p);

export default defineConfig({
  resolve: {
    alias: {
      "@hd/core": r("packages/core/src/index.ts"),
      "@hd/llm": r("packages/llm/src/index.ts"),
      "@hd/rag": r("packages/rag/src/index.ts"),
      "@hd/tools": r("packages/tools/src/index.ts"),
      "@hd/agent-helpdesk": r("packages/agent-helpdesk/src/index.ts"),
      "@hd/eval": r("packages/eval/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // These tests deliberately touch no database and no model: the decision
    // branch is pure, and the parts that are not pure are not what they test.
    testTimeout: 10_000,
    // Writing a ticket enqueues its triage, and the tests delete their tickets
    // when they finish. In the worker's namespace those jobs would be triaged
    // by a running worker mid-test, or wait for the next one to start.
    env: { QUEUE_PREFIX: "hd-test" },
    globalSetup: ["packages/core/test/global-setup.ts"],
  },
});
