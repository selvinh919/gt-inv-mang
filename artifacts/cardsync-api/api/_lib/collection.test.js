import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreatePayload } from "./collection.js";

test("accepts millisecond-sized product identifiers", () => {
  const cardId = Date.now();
  const result = normalizeCreatePayload({ card_id: cardId, card_name: "Custom product" });

  assert.equal(result.error, undefined);
  assert.equal(result.value.card_id, cardId);
});

test("rejects product identifiers that cannot be stored exactly", () => {
  const result = normalizeCreatePayload({
    card_id: Number.MAX_SAFE_INTEGER + 1,
    card_name: "Invalid product",
  });

  assert.match(result.error, /positive safe integer/);
});
