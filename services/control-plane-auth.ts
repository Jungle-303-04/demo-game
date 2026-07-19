import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export const readControlToken = (environment: NodeJS.ProcessEnv = process.env): string => {
  const token = environment.OPS_CONTROL_TOKEN?.trim() ?? "";
  if (environment.REQUIRE_CONTROL_TOKEN === "true" && !token) {
    throw new Error("OPS_CONTROL_TOKEN is required when REQUIRE_CONTROL_TOKEN=true");
  }
  return token;
};

export const controlTokenMatches = (
  authorization: string | string[] | undefined,
  expectedToken: string,
): boolean => {
  if (!expectedToken) return true;
  const header = Array.isArray(authorization) ? authorization[0] ?? "" : authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const suppliedToken = match?.[1] ?? "";
  return timingSafeEqual(digest(suppliedToken), digest(expectedToken));
};

export const withControlToken = (init: RequestInit = {}, token: string): RequestInit => {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
};
