export const DEFAULT_OPSIA_BOT_STARTER_GUNS = [
    "mp5",
    "mac10",
    "vector",
    "hk416",
    "ak47",
    "scar",
    "mosin",
    "m870",
    "mp220",
    "saiga",
    "spas12",
    "m9",
] as const;

export const opsiaBotStarterGunCandidates = (configured?: string): string[] => {
    const candidates = (configured ?? DEFAULT_OPSIA_BOT_STARTER_GUNS.join(","))
        .split(",")
        .map((value) => value.trim())
        .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
    return candidates.length > 0 ? candidates : [...DEFAULT_OPSIA_BOT_STARTER_GUNS];
};

export const selectOpsiaBotStarterGun = (
    candidates: readonly string[],
    random: () => number = Math.random,
): string | undefined => {
    if (candidates.length === 0) return undefined;
    const sample = Math.min(0.999999, Math.max(0, random()));
    return candidates[Math.floor(sample * candidates.length)];
};
