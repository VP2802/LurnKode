/**
 * @file middlewares/auth.middleware.ts
 * @description Resolves caller identity and verifies internal inter-service authentication.
 *
 * Caller identity (learners / instructors), in order of precedence:
 * 1. `Authorization: Bearer <token>` — an RS256 access token issued by M1, verified
 *    against M1's JWKS (M1_JWKS_URL) or public key (JWT_PUBLIC_KEY), issuer and audience.
 *    The token is kept on the context so M3 can call M2 on the caller's behalf.
 * 2. Gateway headers, only when TRUST_GATEWAY_HEADERS is enabled (default outside production):
 *    - X-User-Id: User UUID
 *    - X-User-Role: User role (M1 values "Learner" / "Instructor" / "Admin", any case)
 *    - X-Correlation-Id: Distributed tracing identifier
 *
 * Internal services authenticate via:
 * - X-Internal-Service-Key / X-Internal-Token matching INTERNAL_SERVICE_TOKEN (legacy judge callback)
 * - `Authorization: Bearer <JUDGE_CALLBACK_TOKEN>` for M6 result callbacks
 *
 * Missing/invalid identity is rejected (401) and role mismatches are rejected (403)
 * rather than silently falling back to a development user.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, errors as joseErrors, importSPKI, jwtVerify, type JWTVerifyGetKey, type KeyLike } from "jose";
import { env } from "../config/env";
import { ServiceError } from "./error.middleware";

export const USER_ROLES = ["instructor", "student", "learner", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface UserContext {
  userId: string;
  role: UserRole;
  correlationId?: string;
  /** The caller's M1 access token when authenticated by token; forwarded to M2 for checks made on the caller's behalf. */
  accessToken?: string;
}

type HeaderBag = Headers | Record<string, string | undefined>;

function getHeaderValue(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const obj = headers as Record<string, string | undefined>;
  const lowerName = name.toLowerCase();
  if (obj[lowerName] !== undefined) return obj[lowerName] ?? null;
  if (obj[name] !== undefined) return obj[name] ?? null;

  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lowerName) {
      return obj[key] ?? null;
    }
  }
  return null;
}

/** M1 issues "Learner" | "Instructor" | "Admin"; M3 compares roles in lowercase. */
export function normalizeRole(value: string | null | undefined): UserRole | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  return (USER_ROLES as readonly string[]).includes(lower) ? (lower as UserRole) : null;
}

function getBearerToken(headers: HeaderBag): string | null {
  const value = getHeaderValue(headers, "authorization");
  const match = value ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

/** Reads gateway-injected identity headers. Does not check whether they may be trusted. */
export function extractUserContext(headers: HeaderBag): UserContext | null {
  const userId = getHeaderValue(headers, "x-user-id");
  const role = normalizeRole(getHeaderValue(headers, "x-user-role"));
  const correlationId = getHeaderValue(headers, "x-correlation-id") ?? undefined;

  if (!userId || !role) {
    return null;
  }

  return { userId, role, correlationId };
}

type AccessTokenKey = KeyLike | Uint8Array | JWTVerifyGetKey;

let accessTokenKey: Promise<AccessTokenKey | null> | null = null;

function loadAccessTokenKey(): Promise<AccessTokenKey | null> {
  if (env.JWT_PUBLIC_KEY) {
    const pem = env.JWT_PUBLIC_KEY.includes("-----BEGIN")
      ? env.JWT_PUBLIC_KEY
      : Buffer.from(env.JWT_PUBLIC_KEY, "base64").toString("utf8");
    return importSPKI(pem, "RS256");
  }
  if (env.M1_JWKS_URL) {
    return Promise.resolve(createRemoteJWKSet(new URL(env.M1_JWKS_URL)));
  }
  return Promise.resolve(null);
}

/**
 * Overrides the key used to verify M1 access tokens (tests, custom wiring).
 * Pass `null` to go back to the key configured through the environment.
 */
export function setAccessTokenKey(key: AccessTokenKey | null): void {
  accessTokenKey = key === null ? null : Promise.resolve(key);
}

/** Verifies an M1 access token and returns the identity it carries. */
export async function verifyAccessToken(token: string): Promise<{ userId: string; role: UserRole }> {
  accessTokenKey ??= loadAccessTokenKey();

  let key: AccessTokenKey | null;
  try {
    key = await accessTokenKey;
  } catch (err) {
    console.error("[Auth] M1 public key could not be loaded:", err);
    throw new ServiceError(500, "AUTH_MISCONFIGURED", "Access token verification is misconfigured");
  }
  if (!key) {
    throw new ServiceError(
      401,
      "UNAUTHORIZED",
      "Access tokens are not accepted: M1 token verification is not configured (M1_JWKS_URL / JWT_PUBLIC_KEY)"
    );
  }

  const options = { algorithms: ["RS256"], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE };
  let payload: Record<string, unknown>;
  try {
    const result =
      typeof key === "function" ? await jwtVerify(token, key, options) : await jwtVerify(token, key, options);
    payload = result.payload;
  } catch (err) {
    const keySourceUnavailable =
      !(err instanceof joseErrors.JOSEError) || err instanceof joseErrors.JWKSTimeout;
    if (keySourceUnavailable) {
      console.error("[Auth] M1 JWKS could not be fetched:", err);
      throw new ServiceError(503, "AUTH_UNAVAILABLE", "Identity provider is unavailable; please retry shortly");
    }
    throw new ServiceError(401, "INVALID_TOKEN", "Invalid or expired access token");
  }

  const role = normalizeRole(typeof payload.role === "string" ? payload.role : null);
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || !role) {
    throw new ServiceError(401, "INVALID_TOKEN", "Access token is missing required claims (sub, role)");
  }
  return { userId: payload.sub, role };
}

/**
 * Resolves the caller: an M1 access token wins; gateway headers are used only
 * when they are trusted. Returns null when no identity was presented.
 */
export async function authenticate(
  headers: HeaderBag,
  options: { trustGatewayHeaders?: boolean } = {}
): Promise<UserContext | null> {
  const trustGatewayHeaders = options.trustGatewayHeaders ?? env.TRUST_GATEWAY_HEADERS;
  const correlationId = getHeaderValue(headers, "x-correlation-id") ?? undefined;

  const token = getBearerToken(headers);
  if (token) {
    const identity = await verifyAccessToken(token);
    return { ...identity, correlationId, accessToken: token };
  }

  return trustGatewayHeaders ? extractUserContext(headers) : null;
}

/**
 * Enforces authenticated identity and an allowed role set.
 * Throws 401 for missing/invalid identity and 403 for a disallowed role.
 */
export async function requireRole(
  headers: HeaderBag,
  allowedRoles: readonly UserRole[],
  options: { trustGatewayHeaders?: boolean } = {}
): Promise<UserContext> {
  const trustGatewayHeaders = options.trustGatewayHeaders ?? env.TRUST_GATEWAY_HEADERS;
  const context = await authenticate(headers, { trustGatewayHeaders });

  if (!context) {
    throw new ServiceError(
      401,
      "UNAUTHORIZED",
      trustGatewayHeaders
        ? "Missing or invalid identity: send an M1 access token (Authorization: Bearer) or X-User-Id / X-User-Role headers"
        : "Missing or invalid identity: send an M1 access token (Authorization: Bearer)"
    );
  }

  if (!allowedRoles.includes(context.role)) {
    throw new ServiceError(
      403,
      "FORBIDDEN",
      `Role '${context.role}' is not allowed to access this endpoint`
    );
  }

  return context;
}

/**
 * Constant-time comparison so token verification does not leak length/content
 * through response timing. Hashing first keeps both inputs the same length.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Validates internal service authentication against INTERNAL_SERVICE_TOKEN.
 * Accepts both header conventions:
 * 1. X-Internal-Service-Key (M2 design standard)
 * 2. X-Internal-Token (M3 default standard)
 *
 * Supports both Fetch standard Headers and Elysia request header objects.
 */
export function verifyInternalToken(headers: HeaderBag): boolean {
  const candidates = [
    getHeaderValue(headers, "x-internal-service-key"),
    getHeaderValue(headers, "x-internal-token"),
  ].filter((value): value is string => Boolean(value));

  return candidates.some((token) => constantTimeEquals(token, env.INTERNAL_SERVICE_TOKEN));
}

/** Validates M6's result callback: `Authorization: Bearer <JUDGE_CALLBACK_TOKEN>`. */
export function verifyJudgeCallbackToken(headers: HeaderBag, expected = env.JUDGE_CALLBACK_TOKEN): boolean {
  const token = getBearerToken(headers);
  return Boolean(expected && token && constantTimeEquals(token, expected));
}
