import { startService } from "../../../src/service/host.ts";
try {
  const host = await startService(JSON.parse(process.argv[2]!));
  process.stdout.write(
    JSON.stringify({ owner: true, pid: process.pid }) + "\n",
  );
  process.once("SIGTERM", () => {
    void host.close().then(() => process.exit(0));
  });
} catch (error) {
  if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
  process.stdout.write(
    JSON.stringify({ owner: false, pid: process.pid }) + "\n",
  );
}
