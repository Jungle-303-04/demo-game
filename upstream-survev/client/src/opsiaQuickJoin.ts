const GUEST_ADJECTIVES = [
    "Brave",
    "Calm",
    "Clever",
    "Fast",
    "Lucky",
    "Mighty",
    "Neon",
    "Rapid",
    "Silent",
    "Swift",
] as const;

const GUEST_NOUNS = [
    "Badger",
    "Falcon",
    "Fox",
    "Koala",
    "Otter",
    "Panda",
    "Raven",
    "Shark",
    "Tiger",
    "Wolf",
] as const;

export function isOpsiaPlayPath(pathname: string): boolean {
    return /^\/play\/room-\d+\/?$/.test(pathname);
}

function browserRandom(): number {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0]!;
}

export function createOpsiaGuestName(random = browserRandom): string {
    const adjective = GUEST_ADJECTIVES[random() % GUEST_ADJECTIVES.length]!;
    const noun = GUEST_NOUNS[random() % GUEST_NOUNS.length]!;
    const suffix = String(random() % 100).padStart(2, "0");
    return `${adjective}${noun}${suffix}`.slice(0, 16);
}
