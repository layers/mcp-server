// ask_elle must relay ONLY Elle's reply text, never the raw Mastra generate()
// envelope (which is tens of KB and carries the system prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absolutizeAppLinks,
  appendOnboardingLinks,
  appendPostclaimLinks,
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
    "👉 Connect your accounts ( https://app.layers.com/project/p1/social/accounts?kind=connected ) and Upload your demo video ( https://app.layers.com/project/p1/library ).",
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

test("exposeLinkTargets reads correctly MID-sentence, not just at a sentence end", () => {
  // The colon form ("label: url") only worked when the link ended a sentence.
  // Elle links mid-sentence constantly, and there it produced broken prose:
  // "Once your accounts: https://... are linked, we start the loop."
  const url = "https://app.layers.com/project/p1/social/accounts?kind=connected";
  assert.equal(
    exposeLinkTargets(`Once [your accounts](${url}) are linked, we start the loop.`),
    `Once your accounts ( ${url} ) are linked, we start the loop.`,
  );
});

test("exposeLinkTargets leaves every url whitespace-delimited on both sides", () => {
  // Terminals linkify a bare url by scanning to the next whitespace, and their
  // handling of trailing punctuation varies — `(https://…).` can hand the user
  // a url with `).` glued on. Every emitted url must be its own token.
  const url = "https://app.layers.com/project/p1/social/accounts?kind=connected";
  const out = exposeLinkTargets(
    `Head to [your accounts page](${url}). Then [check gen](${url}), ok?`,
  );
  for (const m of out.matchAll(/https?:\/\/[^\s]+/g)) {
    const before = out[m.index - 1];
    const after = out[m.index + m[0].length];
    assert.equal(before, " ", `no space before ${m[0]}`);
    assert.equal(after, " ", `no space after ${m[0]}`);
  }
});

test("exposeLinkTargets does not double-space when the label IS the url", () => {
  const url = "https://app.layers.com/p/x";
  assert.equal(exposeLinkTargets(`See [${url}](${url}) now.`), `See ${url} now.`);
});

test("exposeLinkTargets preserves list indentation", () => {
  const url = "https://app.layers.com/p/x";
  assert.equal(exposeLinkTargets(`  - [accounts](${url})`), `  - accounts ( ${url} )`);
});

// The relaying agent shipped the claim link ALONE twice in live testing — once
// labelling it "open it to preview your workspace", conflating the two links.
// Flow instructions and then golden rules were both ignored, while the
// link-expansion rules enforced in this same module held perfectly. So the
// hand-off links are a bridge fact now, not a prompt request.
const LINK_SESSION = {
  previewUrl: "https://app.layers.localhost/p/abc123",
  claimUrl: "https://app.layers.localhost/claim?token=xyz",
};
const HANDOFF =
  "Your brand preview is ready! Head over to the claim link your assistant shared to claim your workspace.";

test("appendOnboardingLinks attaches BOTH links on the hand-off turn", () => {
  const out = appendOnboardingLinks(HANDOFF, LINK_SESSION);
  assert.match(out, /Preview your brand: https:\/\/app\.layers\.localhost\/p\/abc123/);
  assert.match(out, /Claim your workspace: https:\/\/app\.layers\.localhost\/claim\?token=xyz/);
});

test("appendOnboardingLinks stays silent mid-intake", () => {
  const q = "Are you running ads today?\n1. Yes\n2. No";
  assert.equal(appendOnboardingLinks(q, LINK_SESSION), q);
});

test("appendOnboardingLinks stays silent once claimed", () => {
  assert.equal(
    appendOnboardingLinks(HANDOFF, { ...LINK_SESSION, claim: { continuity: "same_account" } }),
    HANDOFF,
  );
});

test("appendOnboardingLinks never duplicates a url already in the reply", () => {
  const withPreview = `claim it — ${LINK_SESSION.previewUrl}`;
  assert.equal(appendOnboardingLinks(withPreview, LINK_SESSION), withPreview);
});

test("appendOnboardingLinks is a no-op with no session preview url", () => {
  assert.equal(appendOnboardingLinks(HANDOFF, undefined), HANDOFF);
});

// The turn AFTER the claim. appendOnboardingLinks deliberately stops firing once
// claimed, so this turn had no enforcement at all and went back to naming
// destinations in prose — "your accounts page", "your preview page" — with no
// address attached (observed live 2026-07-29). Same defect as the pre-claim
// version, one turn later.
const CLAIMED_SESSION = {
  previewUrl: "https://app.layers.localhost/p/abc123",
  connectAccountsUrl: "https://app.layers.localhost/project/p1/social/accounts",
  claim: { continuity: "same_account" },
};

test("appendPostclaimLinks attaches the connect-accounts destination", () => {
  const reply =
    "Elle's next step: connect your TikTok and Instagram accounts. You can do that on your accounts page.";
  const out = appendPostclaimLinks(reply, CLAIMED_SESSION);
  assert.match(
    out,
    /Connect your accounts: https:\/\/app\.layers\.localhost\/project\/p1\/social\/accounts/,
  );
});

test("appendPostclaimLinks attaches the preview page when assets are generating", () => {
  const reply =
    "Your influencer, first video, and keyword research are generating now — watch them land on your preview page.";
  const out = appendPostclaimLinks(reply, CLAIMED_SESSION);
  assert.match(out, /Your preview page: https:\/\/app\.layers\.localhost\/p\/abc123/);
});

test("appendPostclaimLinks stays silent on an unrelated turn", () => {
  const reply = "Great — which platform would you like to start with?";
  assert.equal(appendPostclaimLinks(reply, CLAIMED_SESSION), reply);
});

test("appendPostclaimLinks stays silent BEFORE the claim (that turn belongs to appendOnboardingLinks)", () => {
  const reply = "Your assets are generating on your preview page.";
  const preClaim = { ...CLAIMED_SESSION, claim: undefined };
  assert.equal(appendPostclaimLinks(reply, preClaim), reply);
});

test("appendPostclaimLinks never duplicates a url already in the reply", () => {
  const reply =
    "Connect your accounts here: https://app.layers.localhost/project/p1/social/accounts";
  const out = appendPostclaimLinks(reply, CLAIMED_SESSION);
  assert.equal(out.match(/social\/accounts/g).length, 1);
});
