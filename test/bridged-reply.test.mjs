// ask_elle must relay ONLY Elle's reply text, never the raw Mastra generate()
// envelope (which is tens of KB and carries the system prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractElleReply } from "../dist/onboarding/bridged-tools.js";

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
