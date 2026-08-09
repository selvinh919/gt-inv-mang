import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, toErrorPayload } from "./api-errors";

test("ApiError maps to typed payload", () => {
  const err = new ApiError("FORBIDDEN", "nope", 403, { permission: "sales.void" });
  const mapped = toErrorPayload(err);
  assert.equal(mapped.statusCode, 403);
  assert.equal(mapped.payload.error, "FORBIDDEN");
  assert.equal(mapped.payload.message, "nope");
  assert.deepEqual(mapped.payload.details, { permission: "sales.void" });
});

test("unknown error maps to internal error", () => {
  const mapped = toErrorPayload(new Error("boom"));
  assert.equal(mapped.statusCode, 500);
  assert.equal(mapped.payload.error, "INTERNAL_ERROR");
});
