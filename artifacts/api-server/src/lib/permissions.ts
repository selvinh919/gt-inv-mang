export type AppRole =
  | "OWNER"
  | "ADMIN"
  | "MANAGER"
  | "SENIOR_CASHIER"
  | "CASHIER"
  | "INVENTORY"
  | "BUYER";

export const rolePermissions: Record<AppRole, string[]> = {
  OWNER: ["*"],
  ADMIN: [
    "products.read", "products.create", "products.update",
    "inventory.read", "inventory.receive", "inventory.adjust", "inventory.transfer", "inventory.count",
    "sales.read", "sales.create", "sales.discount", "sales.override_price", "sales.void",
    "refunds.create", "refunds.override",
    "customers.read", "customers.update",
    "buylist.create", "buylist.approve",
    "store_credit.issue", "store_credit.adjust",
    "cash_drawer.open", "cash_drawer.adjust", "cash_drawer.close",
    "reports.financial", "staff.manage", "settings.manage",
  ],
  MANAGER: [
    "products.read", "products.create", "products.update",
    "inventory.read", "inventory.receive", "inventory.adjust", "inventory.transfer", "inventory.count",
    "sales.read", "sales.create", "sales.discount", "sales.override_price", "sales.void",
    "refunds.create", "refunds.override",
    "customers.read", "customers.update",
    "buylist.create", "buylist.approve",
    "store_credit.issue", "store_credit.adjust",
    "cash_drawer.open", "cash_drawer.adjust", "cash_drawer.close",
    "reports.financial",
  ],
  SENIOR_CASHIER: [
    "products.read",
    "inventory.read", "inventory.receive",
    "sales.read", "sales.create", "sales.discount",
    "refunds.create",
    "customers.read", "customers.update",
    "cash_drawer.open", "cash_drawer.close",
  ],
  CASHIER: [
    "products.read",
    "inventory.read",
    "sales.read", "sales.create",
    "customers.read",
    "cash_drawer.open", "cash_drawer.close",
  ],
  INVENTORY: [
    "products.read", "products.create", "products.update",
    "inventory.read", "inventory.receive", "inventory.adjust", "inventory.transfer", "inventory.count",
  ],
  BUYER: [
    "products.read",
    "inventory.read", "inventory.receive",
    "buylist.create", "buylist.approve",
    "customers.read", "customers.update",
  ],
};

export function expandPermissions(roles: string[], directPermissions: string[]): Set<string> {
  const result = new Set<string>(directPermissions);

  for (const rawRole of roles) {
    const role = String(rawRole || "").toUpperCase() as AppRole;
    const grants = rolePermissions[role];
    if (!grants) continue;
    for (const permission of grants) {
      result.add(permission);
    }
  }

  return result;
}

export function hasPermission(permissionSet: Set<string>, permission: string): boolean {
  return permissionSet.has("*") || permissionSet.has(permission);
}
