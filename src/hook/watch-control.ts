// Watcher control is an authenticated service request; stale PID files never
// authorize signalling a process.
import { existingService, serviceRequest } from "../service/client.ts";
export async function stopWatcher(
  projectRoot: string,
): Promise<{ stopped: boolean }> {
  const service = await existingService();
  return service
    ? serviceRequest(service, "/service/unwatch", { root: projectRoot })
    : { stopped: false };
}
