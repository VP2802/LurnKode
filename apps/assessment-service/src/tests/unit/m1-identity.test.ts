import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import {
  authenticate,
  extractUserContext,
  normalizeRole,
  requireRole,
  setAccessTokenKey,
  verifyInternalToken,
  verifyJudgeCallbackToken,
} from "../../middlewares/auth.middleware";
import { ServiceError } from "../../middlewares/error.middleware";
import { env } from "../../config/env";

// Mirrors M1's TokenService.issueAccessToken (apps/api/src/services/token.service.ts).
const ISSUER = "https://lurnkode.local/m1";
const AUDIENCE = "lurnkode-api";

let m1PrivateKey: KeyLike;
let otherPrivateKey: KeyLike;

async function m1Token(
  claims: { sub: string; role: string },
  options: { issuer?: string; audience?: string; expiresAt?: number; key?: KeyLike } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "RS256", kid: "m1-auth-key-v1", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now - 120)
    .setExpirationTime(options.expiresAt ?? now + 900)
    .setJti(crypto.randomUUID())
    .sign(options.key ?? m1PrivateKey);
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof ServiceError) return err.statusCode;
    throw err;
  }
}

beforeAll(async () => {
  const m1 = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  m1PrivateKey = m1.privateKey;
  otherPrivateKey = other.privateKey;
  setAccessTokenKey(m1.publicKey);
});

afterAll(() => {
  setAccessTokenKey(null);
});

describe("M1 roles", () => {
  it("accepts M1's capitalised role values", () => {
    expect(normalizeRole("Learner")).toBe("learner");
    expect(normalizeRole("Instructor")).toBe("instructor");
    expect(normalizeRole("ADMIN")).toBe("admin");
    expect(normalizeRole("Owner")).toBeNull();
    expect(normalizeRole(null)).toBeNull();
  });

  it("reads gateway headers that pass M1's role through unchanged", () => {
    expect(extractUserContext({ "x-user-id": "u1", "x-user-role": "Instructor" })).toEqual({
      userId: "u1",
      role: "instructor",
      correlationId: undefined,
    });
  });
});

describe("M1 access tokens", () => {
  it("authenticates a learner from an M1 token and keeps the token for M2 calls", async () => {
    const token = await m1Token({ sub: "3f0c9a8e-1111-4c2b-9d3e-000000000001", role: "Learner" });
    const context = await authenticate({ authorization: `Bearer ${token}`, "x-correlation-id": "trace-123456" });

    expect(context).toEqual({
      userId: "3f0c9a8e-1111-4c2b-9d3e-000000000001",
      role: "learner",
      correlationId: "trace-123456",
      accessToken: token,
    });
  });

  it("lets the token win over conflicting gateway headers", async () => {
    const token = await m1Token({ sub: "learner-from-token", role: "Learner" });
    const context = await authenticate({
      authorization: `Bearer ${token}`,
      "x-user-id": "someone-else",
      "x-user-role": "admin",
    });
    expect(context?.userId).toBe("learner-from-token");
    expect(context?.role).toBe("learner");
  });

  it("enforces roles from the token", async () => {
    const token = await m1Token({ sub: "learner-1", role: "Learner" });
    expect(await statusOf(requireRole({ authorization: `Bearer ${token}` }, ["instructor", "admin"]))).toBe(403);
    expect(await statusOf(requireRole({ authorization: `Bearer ${token}` }, ["learner"]))).toBe(200);
  });

  it("rejects tokens with a bad signature, issuer, audience, expiry or role", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      await m1Token({ sub: "u", role: "Learner" }, { key: otherPrivateKey }),
      await m1Token({ sub: "u", role: "Learner" }, { issuer: "https://evil.example" }),
      await m1Token({ sub: "u", role: "Learner" }, { audience: "another-api" }),
      await m1Token({ sub: "u", role: "Learner" }, { expiresAt: now - 60 }),
      await m1Token({ sub: "u", role: "Superuser" }),
      "not-a-jwt",
    ];
    for (const token of bad) {
      expect(await statusOf(authenticate({ authorization: `Bearer ${token}` }))).toBe(401);
    }
  });
});

describe("gateway headers", () => {
  const spoofed = { "x-user-id": "anyone", "x-user-role": "instructor" };

  it("are ignored when not trusted (production default)", async () => {
    expect(await authenticate(spoofed, { trustGatewayHeaders: false })).toBeNull();
    expect(await statusOf(requireRole(spoofed, ["instructor"], { trustGatewayHeaders: false }))).toBe(401);
  });

  it("are used when trusted (development default)", async () => {
    expect(await authenticate(spoofed, { trustGatewayHeaders: true })).toMatchObject({
      userId: "anyone",
      role: "instructor",
    });
  });
});

describe("internal tokens", () => {
  it("no longer accepts formerly hard-coded secrets unless configured", () => {
    const formerlyHardCoded = ["lurnkode_internal_secret_key_m4", "m3-internal-secret-token"].filter(
      (secret) => secret !== env.INTERNAL_SERVICE_TOKEN
    );
    expect(formerlyHardCoded.length).toBeGreaterThan(0);
    for (const secret of formerlyHardCoded) {
      expect(verifyInternalToken({ "x-internal-token": secret })).toBe(false);
    }
  });

  it("checks M6's Bearer callback token", () => {
    expect(verifyJudgeCallbackToken({ authorization: "Bearer cb-token" }, "cb-token")).toBe(true);
    expect(verifyJudgeCallbackToken({ authorization: "Bearer wrong" }, "cb-token")).toBe(false);
    expect(verifyJudgeCallbackToken({ "x-internal-token": "cb-token" }, "cb-token")).toBe(false);
    expect(verifyJudgeCallbackToken({ authorization: "Bearer cb-token" }, undefined)).toBe(false);
  });
});
