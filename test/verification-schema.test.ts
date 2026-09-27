import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerificationResult } from "../lib/workflow/schemas";
import { PipeError } from "../lib/types";

describe("Verification schema", () => {
  it("A: passes when memoryCandidate is omitted", () => {
    const input = { success: true, summary: "Work order verified." };
    const result = parseVerificationResult(input);
    assert.deepEqual(result, input);
  });

  it("B: passes when memoryCandidate is null", () => {
    const input = { success: true, summary: "Work order verified.", memoryCandidate: null };
    const expected = { success: true, summary: "Work order verified." };
    const result = parseVerificationResult(input);
    assert.deepEqual(result, expected);
  });

  it("C: passes with valid memoryCandidate", () => {
    const input = {
      success: true,
      summary: "Work order verified.",
      memoryCandidate: { text: "t", sourceId: "s" },
    };
    const result = parseVerificationResult(input);
    assert.deepEqual(result, input);
  });

  it("D: fails with missing nested field", () => {
    const input = {
      success: true,
      summary: "ok",
      memoryCandidate: { text: "t" },
    };
    try {
      parseVerificationResult(input);
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.equal(e.kind, "lyzr_malformed");
      assert.equal(e.status, 502);
      assert.match(e.message, /memoryCandidate\.sourceId: Invalid input/);
    }
  });

  it("E: fails with extra top-level field", () => {
    const input = { success: true, summary: "ok", confidence: 0.9 };
    try {
      parseVerificationResult(input);
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.equal(e.kind, "lyzr_malformed");
      assert.match(e.message, /response: Unrecognized key: "confidence"/);
    }
  });

  it("G: fails with wrong type", () => {
    const input = { success: "true", summary: "ok" };
    try {
      parseVerificationResult(input);
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.equal(e.kind, "lyzr_malformed");
      assert.match(e.message, /success: Invalid input: expected boolean, received string/);
    }
  });
});
