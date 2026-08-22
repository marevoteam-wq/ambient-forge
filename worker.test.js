import { describe, expect, it, vi } from "vitest";
import worker from "./worker.mjs";

describe("production worker", () => {
  it("redirects public HTTP requests to HTTPS", async () => {
    const response = await worker.fetch(new Request("http://ambient-forge.marevo.workers.dev/about"), { ASSETS: { fetch: vi.fn() } });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://ambient-forge.marevo.workers.dev/about");
  });

  it("adds security and embedding headers to static assets", async () => {
    const assets = { fetch: vi.fn(async () => new Response("ok", { headers: { "content-type": "text/plain" } })) };
    const response = await worker.fetch(new Request("https://ambient-forge.marevo.workers.dev/manifest.json"), { ASSETS: assets });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://owlbear.rodeo");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("answers preflight requests without hitting static assets", async () => {
    const assets = { fetch: vi.fn() };
    const response = await worker.fetch(new Request("https://ambient-forge.marevo.workers.dev/manifest.json", { method: "OPTIONS" }), { ASSETS: assets });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});
