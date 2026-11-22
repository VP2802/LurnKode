import { z } from "zod";

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/lurnkode_assessment?schema=public";
const DEFAULT_INTERNAL_TOKEN = "m3-internal-secret-token";
/** M6's development callback token (m6-judge/docker-compose.yml). Never accepted in production. */
const DEV_JUDGE_CALLBACK_TOKEN = "dev-callback-token";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * Environment configuration schema for the Assessment Microservice (M3).
 * Validates all required environment variables at service startup.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4003),
  HOST: z.string().default("0.0.0.0"),

  // Dedicated Database (Database-per-Service)
  DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),

  // Redis for BullMQ Task Queue and Event Publishing
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Inter-Service Communication (M2 Course Service, served by the M1/M2 `api` app)
  M2_COURSE_SERVICE_URL: z.string().default("http://localhost:8000"),
  M2_REQUEST_TIMEOUT_MS: z.coerce.number().default(500),
  /** Key M2 expects in X-Internal-Service-Key. Defaults to INTERNAL_SERVICE_TOKEN. */
  M2_INTERNAL_SERVICE_KEY: z.string().optional(),

  // Security & Internal Tokens
  INTERNAL_SERVICE_TOKEN: z.string().default(DEFAULT_INTERNAL_TOKEN),

  // M1 identity: access tokens are RS256 JWTs signed by M1.
  /** M1 JWKS endpoint, e.g. http://api:8000/.well-known/jwks.json */
  M1_JWKS_URL: z.string().url().optional(),
  /** Alternative to M1_JWKS_URL: M1's public key as PEM or base64-encoded PEM. */
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_ISSUER: z.string().default("https://lurnkode.local/m1"),
  JWT_AUDIENCE: z.string().default("lurnkode-api"),
  /**
   * Trust X-User-Id / X-User-Role headers from an upstream gateway. Defaults to
   * true outside production (local demos, tests) and false in production, where
   * callers must present an M1 access token instead.
   */
  TRUST_GATEWAY_HEADERS: booleanFlag.optional(),

  // M6 Judge Service
  /** M6 judge-api base URL, e.g. http://judge-api:4000. Unset = local stub (use scripts/fake-judge.ts). */
  JUDGE_API_URL: z.string().url().optional(),
  /** Service token M6 issued to M3 (needs the `submit` scope). */
  JUDGE_API_TOKEN: z.string().optional(),
  JUDGE_REQUEST_TIMEOUT_MS: z.coerce.number().default(3000),
  /** Bearer token M6 sends on result callbacks (M6's CALLBACK_TOKEN). */
  JUDGE_CALLBACK_TOKEN: z.string().optional(),
});

type RawEnv = z.infer<typeof envSchema>;

export type EnvConfig = Omit<RawEnv, "TRUST_GATEWAY_HEADERS" | "M2_INTERNAL_SERVICE_KEY" | "JUDGE_CALLBACK_TOKEN"> & {
  TRUST_GATEWAY_HEADERS: boolean;
  M2_INTERNAL_SERVICE_KEY: string;
  /** Undefined when no callback token is configured: M6 callbacks are then rejected. */
  JUDGE_CALLBACK_TOKEN: string | undefined;
};

function loadEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables for Assessment Service:", result.error.format());
    throw new Error("Invalid service environment configuration");
  }

  const raw = result.data;
  const isProduction = raw.NODE_ENV === "production";

  const config: EnvConfig = {
    ...raw,
    TRUST_GATEWAY_HEADERS: raw.TRUST_GATEWAY_HEADERS ?? !isProduction,
    M2_INTERNAL_SERVICE_KEY: raw.M2_INTERNAL_SERVICE_KEY ?? raw.INTERNAL_SERVICE_TOKEN,
    JUDGE_CALLBACK_TOKEN: raw.JUDGE_CALLBACK_TOKEN ?? (isProduction ? undefined : DEV_JUDGE_CALLBACK_TOKEN),
  };

  // Development conveniences must not silently become production secrets.
  if (isProduction) {
    if (config.INTERNAL_SERVICE_TOKEN === DEFAULT_INTERNAL_TOKEN) {
      throw new Error(
        "INTERNAL_SERVICE_TOKEN must be explicitly configured in production (default token is not allowed)"
      );
    }
    if (config.DATABASE_URL === DEFAULT_DATABASE_URL) {
      throw new Error(
        "DATABASE_URL must be explicitly configured in production (default URL is not allowed)"
      );
    }
    if (!config.TRUST_GATEWAY_HEADERS && !config.M1_JWKS_URL && !config.JWT_PUBLIC_KEY) {
      throw new Error(
        "Set M1_JWKS_URL or JWT_PUBLIC_KEY in production so M3 can verify M1 access tokens " +
          "(or TRUST_GATEWAY_HEADERS=true when a gateway injects verified identity headers)"
      );
    }
    if (config.JUDGE_CALLBACK_TOKEN === DEV_JUDGE_CALLBACK_TOKEN) {
      throw new Error("JUDGE_CALLBACK_TOKEN must not use the M6 development token in production");
    }
  }

  if (config.JUDGE_API_URL && !config.JUDGE_API_TOKEN) {
    throw new Error("JUDGE_API_TOKEN is required when JUDGE_API_URL is set");
  }

  return config;
}

export const env = loadEnv();
