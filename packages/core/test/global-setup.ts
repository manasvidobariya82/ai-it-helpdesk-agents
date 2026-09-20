import type { GlobalSetupContext } from "vitest/node";

/**
 * Empties the test run's queues before it starts.
 *
 * `vitest.config.ts` gives the tests their own queue prefix so a running
 * worker never sees their jobs. The flip side is that nothing consumes that
 * namespace, so without this every run's jobs would stay in Redis for good.
 *
 * Best effort. With Redis down the tests that need it already degrade, and a
 * setup that refused to start would take the unit tests down with them.
 */
export default async function setup({ config }: GlobalSetupContext): Promise<void> {
  // Core reads the prefix once, when it loads, so it has to be set first.
  // This process is not a test worker and does not get `test.env` on its own.
  process.env.QUEUE_PREFIX = config.env.QUEUE_PREFIX;
  const { closeQueues, obliterateQueues } = await import("../src/queue.js");
  try {
    await obliterateQueues();
  } catch (err) {
    console.warn(`[setup] test queues not emptied: ${(err as Error).message}`);
  } finally {
    await closeQueues().catch(() => {});
  }
}
