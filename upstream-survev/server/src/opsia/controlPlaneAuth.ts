import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export const readControlToken = (environment: NodeJS.ProcessEnv = process.env): string => {
    const token = environment.OPS_CONTROL_TOKEN?.trim() ?? "";
    if (environment.REQUIRE_CONTROL_TOKEN === "true" && !token) {
        throw new Error("OPS_CONTROL_TOKEN is required when REQUIRE_CONTROL_TOKEN=true");
    }
    return token;
};

export const controlTokenMatches = (authorization: string | undefined, expectedToken: string): boolean => {
    if (!expectedToken) return true;
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    const suppliedToken = match?.[1] ?? "";
    return timingSafeEqual(digest(suppliedToken), digest(expectedToken));
};
