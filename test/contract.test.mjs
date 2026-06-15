// Request-contract tests: what the server actually puts on the wire, verified
// against a localhost mock. Hermetic — no key, no outbound network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withMockApi, callTool, parseUrl } from "./helpers.mjs";

test("sends Bearer auth on every request", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "whoami");
    await callTool(client, "list_projects");
    assert.ok(reqs.length >= 2);
    for (const r of reqs) assert.equal(r.headers["authorization"], "Bearer lp_test_x");
  });
});

test("omits X-Layers-Organization unless --organization is set", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "whoami"); // GET
    await callTool(client, "upload_content_from_url", {
      projectId: "prj_1", media: [{ url: "https://example.com/y.mp4" }], caption: "",
    }); // POST
    assert.ok(reqs.length >= 2);
    for (const r of reqs) assert.equal(r.headers["x-layers-organization"], undefined);
  });
});

test("sends X-Layers-Organization on every request when configured", async () => {
  await withMockApi(
    async (client, reqs) => {
      await callTool(client, "whoami");
      await callTool(client, "list_projects");
      for (const r of reqs) assert.equal(r.headers["x-layers-organization"], "org_child_test");
    },
    { extraArgs: ["--organization", "org_child_test"] },
  );
});

test("adds an Idempotency-Key to mutating POST/PATCH but not to GET/DELETE", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "list_content", { projectId: "prj_1" }); // GET
    await callTool(client, "upload_content_from_url", {
      projectId: "prj_1", media: [{ url: "https://example.com/y.mp4" }], caption: "",
    }); // POST
    await callTool(client, "update_content_caption", { containerId: "cnt_1", caption: "x" }); // PATCH
    await callTool(client, "cancel_scheduled_post", { scheduledPostId: "sp_1" }); // DELETE

    const find = (method) => reqs.find((r) => r.method === method);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.equal(find("GET").headers["idempotency-key"], undefined);
    assert.match(find("POST").headers["idempotency-key"] ?? "", uuid);
    assert.match(find("PATCH").headers["idempotency-key"] ?? "", uuid);
    assert.equal(find("DELETE").headers["idempotency-key"], undefined);
  });
});

test("repeats array query params and serializes scalars once", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "list_content", {
      projectId: "prj_1", status: ["queued", "processing"], creativeType: "uploaded", limit: 10,
    });
    const url = parseUrl(reqs[0]);
    assert.deepEqual(url.searchParams.getAll("status"), ["queued", "processing"]);
    assert.deepEqual(url.searchParams.getAll("creativeType"), ["uploaded"]);
    assert.equal(url.searchParams.get("limit"), "10");
  });
});

test("transmits a required-but-empty caption verbatim", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "upload_content_from_url", {
      projectId: "prj_1", media: [{ url: "https://example.com/y.mp4" }], caption: "",
    });
    assert.equal(JSON.parse(reqs[0].body).caption, "");
  });
});

test("drops undefined body fields but preserves an explicit null", async () => {
  await withMockApi(async (client, reqs) => {
    // undefined-dropping: a PATCH with one field carries only that field
    await callTool(client, "update_project", { projectId: "prj_1", timezone: "UTC" });
    assert.deepEqual(JSON.parse(reqs[0].body), { timezone: "UTC" });

    // null-preserving: clearing an override must actually send override: null
    await callTool(client, "update_ads_content", { projectId: "prj_1", adsContentId: "adc_1", override: null });
    const body = JSON.parse(reqs[1].body);
    assert.equal(body.override, null);
    assert.ok(!("note" in body), "an undefined optional field must be dropped");
  });
});

test("sets Content-Type: application/json only on requests with a body", async () => {
  await withMockApi(async (client, reqs) => {
    await callTool(client, "list_projects"); // GET, no body
    await callTool(client, "upload_content_from_url", {
      projectId: "prj_1", media: [{ url: "https://example.com/y.mp4" }], caption: "",
    }); // POST, body
    assert.equal(reqs.find((r) => r.method === "GET").headers["content-type"], undefined);
    assert.equal(reqs.find((r) => r.method === "POST").headers["content-type"], "application/json");
  });
});

test("serializes the targets array into the schedule/publish body", async () => {
  await withMockApi(async (client, reqs) => {
    const targets = [{ socialAccountId: "sa_1", mode: "draft" }];
    await callTool(client, "schedule_content", { containerId: "cnt_1", scheduledFor: "2030-01-01T00:00:00Z", targets });
    await callTool(client, "publish_content", { containerId: "cnt_1", targets });

    const scheduled = JSON.parse(reqs[0].body);
    assert.deepEqual(scheduled.targets, targets);
    assert.equal(scheduled.scheduledFor, "2030-01-01T00:00:00Z");
    assert.deepEqual(JSON.parse(reqs[1].body).targets, targets);
  });
});

test("routes each tool to its documented method and path", async () => {
  const cases = [
    ["whoami", {}, "GET", "/v1/whoami"],
    ["get_credits", {}, "GET", "/v1/credits"],
    ["list_projects", {}, "GET", "/v1/projects"],
    ["get_project", { projectId: "prj_1" }, "GET", "/v1/projects/prj_1"],
    ["list_content", { projectId: "prj_1" }, "GET", "/v1/projects/prj_1/content"],
    ["get_metrics", { projectId: "prj_1", scope: "project", id: "prj_1" }, "GET", "/v1/projects/prj_1/metrics"],
    ["list_audit_log", {}, "GET", "/v1/audit-log"],
    ["create_content_upload",
      { projectId: "prj_1", files: [{ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 1 }], grouping: "per-file" },
      "POST", "/v1/projects/prj_1/content/uploads"],
    ["upload_content_from_url",
      { projectId: "prj_1", media: [{ url: "https://example.com/y.mp4" }], caption: "" },
      "POST", "/v1/projects/prj_1/content/upload"],
    ["finalize_content_upload", { containerId: "cnt_1", caption: "x" }, "POST", "/v1/content/cnt_1/finalize-upload"],
    ["update_content_caption", { containerId: "cnt_1", caption: "x" }, "PATCH", "/v1/content/cnt_1"],
    ["schedule_content",
      { containerId: "cnt_1", scheduledFor: "2030-01-01T00:00:00Z", targets: [{ socialAccountId: "sa_1", mode: "draft" }] },
      "POST", "/v1/content/cnt_1/schedule"],
    ["publish_content",
      { containerId: "cnt_1", targets: [{ socialAccountId: "sa_1", mode: "draft" }] },
      "POST", "/v1/content/cnt_1/publish"],
    ["cancel_scheduled_post", { scheduledPostId: "sp_1" }, "DELETE", "/v1/scheduled-posts/sp_1"],
  ];

  await withMockApi(async (client, reqs) => {
    for (const [name, args] of cases) await callTool(client, name, args);
    cases.forEach(([name, , method, pathname], i) => {
      assert.equal(reqs[i].method, method, `${name} method`);
      assert.equal(parseUrl(reqs[i]).pathname, pathname, `${name} path`);
    });
  });
});

test("renders the API error envelope as an isError result without leaking the key", async () => {
  const handler = () => ({
    status: 404,
    json: {
      error: {
        code: "NOT_FOUND",
        message: "Project not found.",
        requestId: "req_test123",
        details: { projectId: "prj_x" },
      },
    },
  });
  await withMockApi(
    async (client) => {
      const r = await callTool(client, "get_project", { projectId: "prj_x" });
      assert.ok(r.isError, "non-2xx should surface as an isError tool result");
      assert.match(r.text, /404/);
      assert.match(r.text, /NOT_FOUND/);
      assert.match(r.text, /req_test123/);
      assert.doesNotMatch(r.text, /lp_test_x/, "the bearer token must never appear in output");
    },
    { handler },
  );
});
