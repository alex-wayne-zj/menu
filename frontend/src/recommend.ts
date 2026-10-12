import type { Kind } from "./types.ts";
type Candidate = { id: number; kind: Kind };
export function recommend<T extends Candidate>(
  filtered: T[],
  selected: Candidate[],
  previous?: number,
  random = Math.random,
): { dish: T | null; message: string } {
  const chosen = new Set(selected.map((d) => d.id));
  const candidates = filtered.filter((d) => !chosen.has(d.id));
  if (!candidates.length)
    return {
      dish: null,
      message: "当前筛选没有可推荐的菜，试试其他分类，或添加新菜。",
    };
  const meat = selected.some((d) => d.kind === "meat"),
    vegetable = selected.some((d) => d.kind === "vegetable");
  const missing: Kind | null =
    meat && !vegetable ? "vegetable" : vegetable && !meat ? "meat" : null;
  const preferred = missing
    ? candidates.filter((d) => d.kind === missing)
    : candidates;
  let pool = preferred.length ? preferred : candidates;
  let message =
    missing && !preferred.length
      ? `当前筛选没有${missing === "meat" ? "荤菜" : "素菜"}，先推荐其他菜；可调整筛选补齐。`
      : missing
        ? `帮你补一道${missing === "meat" ? "荤菜" : "素菜"}。`
        : "给今天添一点新意。";
  if (pool.length > 1) pool = pool.filter((d) => d.id !== previous);
  else message += " 当前推荐范围仅此一道。";
  return {
    dish: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))],
    message,
  };
}
