// ask_elle must relay ONLY Elle's reply text, never the raw Mastra generate()
// envelope (which is tens of KB and carries the system prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absolutizeAppLinks,
  exposeLinkTargets,
  extractElleReply,
} from "../dist/onboarding/bridged-tools.js";

const ELLE_REPLY =
  "I'm Elle, your Layers marketing expert. Do you have social profiles on TikTok or Instagram?";

// A realistic (trimmed) shape of what ask_onboardingGuide returns: the whole
// generate() envelope JSON-stringified into a single text content block.
function envelopeResult(text) {
  const envelope = {
    text,
    usage: { inputTokens: 1178, outputTokens: 70 },
    steps: [{ stepType: "initial", toolCalls: [{ toolName: "getOnboardingBrief" }] }],
    request: {
      body: {
        systemInstruction: {
          parts: [{ text: "SECRET SYSTEM PROMPT — must never reach the human." }],
        },
      },
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}

function fullElleEnvelopeResult(text) {
  const envelope = {
    text,
    content: [{ type: "text", text }],
    usage: { inputTokens: 2214, outputTokens: 84 },
    steps: [
      {
        stepType: "initial",
        toolCalls: [{ toolName: "getProject", args: { projectId: "prj_hidden" } }],
      },
    ],
    request: {
      body: {
        systemInstruction: {
          parts: [{ text: "FULL ELLE SYSTEM PROMPT — must never reach the human." }],
        },
      },
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}

test("extractElleReply returns only the reply text from a full envelope", () => {
  assert.equal(extractElleReply(envelopeResult(ELLE_REPLY)), ELLE_REPLY);
});

test("extractElleReply handles the full Elle ask_elle envelope shape", () => {
  const reply = extractElleReply(fullElleEnvelopeResult("Your first assets are landing now."));
  assert.equal(reply, "Your first assets are landing now.");
  assert.doesNotMatch(reply ?? "", /FULL ELLE SYSTEM PROMPT|inputTokens|getProject/);
});

test("extractElleReply never leaks the system prompt or envelope internals", () => {
  const reply = extractElleReply(envelopeResult(ELLE_REPLY));
  assert.doesNotMatch(reply ?? "", /SECRET SYSTEM PROMPT/);
  assert.doesNotMatch(reply ?? "", /systemInstruction|inputTokens|stepType/);
});

test("extractElleReply falls back to stitched content parts when top-level text is empty", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          text: "",
          content: [
            { type: "text", text: "Hello " },
            { type: "tool-call", toolName: "x" },
            { type: "text", text: "there." },
          ],
        }),
      },
    ],
  };
  assert.equal(extractElleReply(result), "Hello there.");
});

test("extractElleReply passes plain-text replies through verbatim", () => {
  const result = { content: [{ type: "text", text: "just a plain reply" }] };
  assert.equal(extractElleReply(result), "just a plain reply");
});

test("extractElleReply returns null (not the raw JSON) when no reply text exists", () => {
  const result = {
    content: [{ type: "text", text: JSON.stringify({ usage: { inputTokens: 5 } }) }],
  };
  assert.equal(extractElleReply(result), null);
});

test("extractElleReply returns null on empty content", () => {
  assert.equal(extractElleReply({ content: [] }), null);
});

test("absolutizeAppLinks rewrites root-relative markdown links against the session origin", () => {
  const session = { workspaceUrl: "https://app.layers.localhost/project/p1/chats" };
  const reply =
    "Connect via [Instagram](/project/p1/social/accounts?kind=connected) and watch in [Generations](/project/p1/social/generations).";
  const out = absolutizeAppLinks(reply, session);
  assert.match(out, /\(https:\/\/app\.layers\.localhost\/project\/p1\/social\/accounts\?kind=connected\)/);
  assert.match(out, /\(https:\/\/app\.layers\.localhost\/project\/p1\/social\/generations\)/);
});

test("absolutizeAppLinks rewrites project-relative markdown links against the workspace project", () => {
  const session = { workspaceUrl: "https://app.layers.localhost/project/p1/chats" };
  const reply =
    "Connect via [Instagram](social/accounts?kind=connected) and watch in [Generations](social/generations).";
  const out = absolutizeAppLinks(reply, session);
  assert.match(out, /\(https:\/\/app\.layers\.localhost\/project\/p1\/social\/accounts\?kind=connected\)/);
  assert.match(out, /\(https:\/\/app\.layers\.localhost\/project\/p1\/social\/generations\)/);
});

test("absolutizeAppLinks leaves absolute links and plain text untouched", () => {
  const session = { workspaceUrl: "https://app.layers.com/project/p1/chats" };
  const reply = "See [docs](https://docs.layers.com/x) and plain /project/p1 text.";
  assert.equal(absolutizeAppLinks(reply, session), reply);
});

test("absolutizeAppLinks is a no-op without a session origin", () => {
  const reply = "[a](/project/p1/chats)";
  assert.equal(absolutizeAppLinks(reply, undefined), reply);
});

test("absolutizeAppLinks leaves project-relative links unchanged without workspaceUrl", () => {
  const session = { previewUrl: "https://app.layers.com/p/preview1" };
  const reply = "Connect via [Instagram](social/accounts?kind=connected).";
  assert.equal(absolutizeAppLinks(reply, session), reply);
});

test("absolutizeAppLinks leaves project-relative links unchanged without a project workspace path", () => {
  const session = { workspaceUrl: "https://app.layers.com/chats" };
  const reply = "Connect via [Instagram](social/accounts?kind=connected).";
  assert.equal(absolutizeAppLinks(reply, session), reply);
});

test("absolutizeAppLinks leaves scheme-less brand links untouched", () => {
  // Elle knows the brand's own domain, so `](sonos.com)` is a link she can
  // plausibly write. It starts with an alphanumeric exactly like an app path
  // does — rewriting it would yield `/project/p1/sonos.com`, a dead link.
  const session = { workspaceUrl: "https://app.layers.com/project/p1/chats" };
  const reply = "Their site is [Sonos](sonos.com) and their docs are [here](docs.sonos.com/setup).";
  assert.equal(absolutizeAppLinks(reply, session), reply);
});

test("absolutizeAppLinks leaves anchors, mailto, and protocol-relative links untouched", () => {
  const session = { workspaceUrl: "https://app.layers.com/project/p1/chats" };
  const reply = "Use [anchor](#next), [email](mailto:hi@layers.com), and [cdn](//cdn.layers.com/x).";
  assert.equal(absolutizeAppLinks(reply, session), reply);
});

test("exposeLinkTargets unwraps markdown links into visible URLs", () => {
  // Founder click-through 2026-07-22: the terminal rendered [Connect your
  // accounts](url) as colored-but-dead text. URLs must be copyable plain text.
  const reply =
    "👉 [Connect your accounts](https://app.layers.com/project/p1/social/accounts?kind=connected) and [Upload your demo video](https://app.layers.com/project/p1/library).";
  assert.equal(
    exposeLinkTargets(reply),
    "👉 Connect your accounts: https://app.layers.com/project/p1/social/accounts?kind=connected and Upload your demo video: https://app.layers.com/project/p1/library.",
  );
});

test("exposeLinkTargets collapses a link whose text is already the URL", () => {
  const reply = "See [https://app.layers.com/p/x](https://app.layers.com/p/x) now.";
  assert.equal(exposeLinkTargets(reply), "See https://app.layers.com/p/x now.");
});

test("exposeLinkTargets leaves non-http links and plain text untouched", () => {
  const reply = "Email [us](mailto:hi@layers.com), see [notes](#below), plain https://layers.com text.";
  assert.equal(exposeLinkTargets(reply), reply);
});
