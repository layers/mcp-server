// Opt-in live smoke test against the Layers SANDBOX API. NOT part of `npm test`.
//
// Exercises the real content lifecycle end-to-end against fixture-backed sandbox
// endpoints: create a throwaway project, generate a slideshow, upload media by
// URL, edit its caption, then archive the project (always, even on failure).
// It refuses any non-sandbox key and never publishes live.
//
//   LAYERS_TEST_KEY=lp_test_xxx node scripts/smoke.mjs
//   LAYERS_TEST_KEY=lp_test_xxx LAYERS_TEST_BASE_URL=https://api.layers.com node scripts/smoke.mjs
import { startClient, callTool } from "../test/helpers.mjs";

const KEY = process.env.LAYERS_TEST_KEY;
if (!KEY?.startsWith("lp_test_")) {
  console.error("Set LAYERS_TEST_KEY to a SANDBOX key (lp_test_...). Refusing to run against a live key.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = (r) => { try { return JSON.parse(r.text); } catch { return r.text; } };
const need = (r, what) => { if (r.isError) throw new Error(`${what}: ${r.text.split("\n")[0]}`); return data(r); };

const client = await startClient([], { apiKey: KEY, baseUrl: process.env.LAYERS_TEST_BASE_URL });
let projectId;
try {
  console.log("• whoami");
  const me = need(await callTool(client, "whoami"), "whoami");
  console.log("  org:", me.organizationId, "| tier:", me.rateLimitTier);

  console.log("• create_project");
  projectId = need(await callTool(client, "create_project", {
    name: `Smoke ${process.pid}`,
    timezone: "UTC",
    appName: "Smoke Test App",
    appDescription:
      "A throwaway project created by the public test harness to exercise the content lifecycle against sandbox fixtures. Safe to archive at any time.",
  }), "create_project").id;
  console.log("  projectId:", projectId);

  console.log("• get_hooks");
  const hook = (data(await callTool(client, "get_hooks", { projectId })).hooks ?? [])[0]
    ?? "wait for it...\\nthis simple habit changed everything";

  console.log("• generate_slideshow → poll progress");
  const gen = need(await callTool(client, "generate_slideshow", { projectId, hook }), "generate_slideshow");
  const containerId = gen.containerIds?.[0];
  let status = "queued";
  for (let i = 0; i < 60 && !["completed", "failed", "canceled"].includes(status); i++) {
    await sleep(5000);
    const p = await callTool(client, "get_content_progress", { containerId });
    status = data(p)?.status ?? status;
    console.log("  …", status, p.isError ? `(${p.text.split("\n")[0]})` : "");
  }
  if (status !== "completed") throw new Error(`generation ended '${status}'`);

  console.log("• upload_content_from_url + update_content_caption");
  const up = need(await callTool(client, "upload_content_from_url", {
    projectId, caption: "smoke upload",
    media: [{ url: "https://download.samplelib.com/mp4/sample-5s.mp4" }],
  }), "upload_content_from_url");
  need(await callTool(client, "update_content_caption", { containerId: up.id, caption: "smoke upload (edited)" }), "update_content_caption");

  console.log("\nSMOKE OK ✓");
} catch (e) {
  console.error("\nSMOKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (projectId) {
    const arch = await callTool(client, "archive_project", { projectId });
    console.log(arch.isError ? `cleanup: archive failed (${arch.text.split("\n")[0]})` : "cleanup: archived");
  }
  await client.close();
}
