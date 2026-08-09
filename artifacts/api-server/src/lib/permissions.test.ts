import test from "node:test";
import assert from "node:assert/strict";
import { expandPermissions, hasPermission } from "./permissions";

test("OWNER role expands to wildcard permissions", () => {
  const permissions = expandPermissions(["OWNER"], []);
  assert.equal(hasPermission(permissions, "sales.create"), true);
  assert.equal(hasPermission(permissions, "reports.financial"), true);
});

test("CASHIER role has sales.create but not reports.financial", () => {
  const permissions = expandPermissions(["CASHIER"], []);
  assert.equal(hasPermission(permissions, "sales.create"), true);
  assert.equal(hasPermission(permissions, "reports.financial"), false);
});

test("direct permissions are included", () => {
  const permissions = expandPermissions([], ["inventory.adjust"]);
  assert.equal(hasPermission(permissions, "inventory.adjust"), true);
});
