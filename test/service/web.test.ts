import { expect, test } from "bun:test";
import { startWebUi } from "../../src/web/server.ts";

test("web explorer permits only authenticated reads and closes its service client", async () => {
  let closed = false;
  const web = await startWebUi({ client: { request: async () => ({ projects: [] }), close: async () => { closed = true; } } });
  try {
    const url = new URL(web.url); const token = url.hash.slice(1); url.hash = "";
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(new URL("/api?tool=list_projects", url))).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(new URL("/api?tool=list_projects", url), { headers })).status).toBe(200);
    expect((await fetch(new URL("/api?tool=index_project", url), { headers })).status).toBe(403);
    expect((await fetch(new URL("/api?tool=list_projects", url), { headers, method: "POST" })).status).toBe(405);
    expect((await fetch(new URL("/api?tool=list_projects", url), { headers: { ...headers, Origin: "https://example.com" } })).status).toBe(403);
  } finally { await web.close(); }
  expect(closed).toBe(true);
});
