import pg from "pg";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

const poolSymbol = Symbol.for("cardsync.auth.pg.pool");
const readySymbol = Symbol.for("cardsync.auth.pg.ready");
const globalStore = globalThis;

function getConnectionString() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) {
    throw new Error("Missing DATABASE_URL");
  }
  return value;
}

function getPool() {
  if (!globalStore[poolSymbol]) {
    globalStore[poolSymbol] = new pg.Pool({ connectionString: getConnectionString() });
  }
  return globalStore[poolSymbol];
}

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "owner" || value === "manager" || value === "clerk") return value;
  return "clerk";
}

function jwtRolesForRole(role) {
  if (role === "owner") return ["OWNER"];
  if (role === "manager") return ["MANAGER"];
  return ["CASHIER"];
}

export function userRoleToJwtRoles(role) {
  return jwtRolesForRole(normalizeRole(role));
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${Buffer.from(derivedKey).toString("base64url")}`;
}

async function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expected = Buffer.from(parts[5], "base64url");

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || !salt || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length, {
    N: n,
    r,
    p,
  });

  return timingSafeEqual(expected, Buffer.from(derived));
}

export async function ensureAuthUsersTable() {
  if (!globalStore[readySymbol]) {
    const pool = getPool();
    globalStore[readySymbol] = pool.query(`
      create table if not exists auth_users (
        id bigserial primary key,
        email text not null unique,
        name text not null,
        password_hash text not null,
        role text not null default 'clerk',
        active boolean not null default true,
        external_sub text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists auth_users_role_idx on auth_users (role);
      create index if not exists auth_users_active_idx on auth_users (active);
    `);
  }

  await globalStore[readySymbol];
}

export async function findUserByEmail(email) {
  await ensureAuthUsersTable();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const pool = getPool();
  const result = await pool.query(
    `select id, email, name, password_hash, role, active, external_sub from auth_users where lower(email) = $1 limit 1`,
    [normalizedEmail],
  );

  return result.rows[0] || null;
}

export async function authenticateLocalUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.active) return null;

  const valid = await verifyPassword(password, user.password_hash);
  return valid ? user : null;
}

export async function registerLocalUser({ name, email, password, role, externalSub }) {
  await ensureAuthUsersTable();

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedName = String(name || "").trim() || normalizedEmail;
  const normalizedRole = normalizeRole(role);
  const passwordHash = await hashPassword(password);

  const pool = getPool();
  const result = await pool.query(
    `insert into auth_users (email, name, password_hash, role, active, external_sub)
     values ($1, $2, $3, $4, true, $5)
     returning id, email, name, role, active, external_sub`,
    [normalizedEmail, normalizedName, passwordHash, normalizedRole, externalSub || null],
  );

  return result.rows[0];
}

export async function resetLocalPassword(email, newPassword) {
  await ensureAuthUsersTable();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const passwordHash = await hashPassword(newPassword);

  const pool = getPool();
  const result = await pool.query(
    `update auth_users set password_hash = $2, updated_at = now() where lower(email) = $1 returning id, email, name, role, active, external_sub`,
    [normalizedEmail, passwordHash],
  );

  return result.rows[0] || null;
}

export async function migrateLocalUsers(users) {
  await ensureAuthUsersTable();
  if (!Array.isArray(users)) return { imported: 0, skipped: 0 };

  const pool = getPool();
  let imported = 0;
  let skipped = 0;

  for (const candidate of users) {
    const email = String(candidate?.email || "").trim().toLowerCase();
    const name = String(candidate?.name || email).trim() || email;
    const password = String(candidate?.password || "").trim();
    const role = normalizeRole(candidate?.role);
    const active = candidate?.active !== false;

    if (!email || !password || !active) {
      skipped += 1;
      continue;
    }

    const passwordHash = await hashPassword(password);

    const result = await pool.query(
      `insert into auth_users (email, name, password_hash, role, active)
       values ($1, $2, $3, $4, true)
       on conflict (email) do update
         set name = excluded.name,
             password_hash = excluded.password_hash,
             role = excluded.role,
             active = true,
             updated_at = now()
       returning id`,
      [email, name, passwordHash, role],
    );

    if (result.rowCount > 0) imported += 1;
    else skipped += 1;
  }

  return { imported, skipped };
}
