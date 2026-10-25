import { useSyncExternalStore } from "react";

/**
 * Screen-size classes from docs/ui-rebuild-plan.md §4:
 *   desktop ≥1280 (chat docked) · laptop 1024–1279 (chat drawer)
 *   tablet 768–1023 (people panel collapsed, chat drawer) · phone <768 (blocked)
 */
export type Layout = "desktop" | "laptop" | "tablet" | "phone";

const QUERIES: Array<[Layout, string]> = [
  ["phone", "(max-width: 767.98px)"],
  ["tablet", "(max-width: 1023.98px)"],
  ["laptop", "(max-width: 1279.98px)"],
];

function current(): Layout {
  for (const [layout, q] of QUERIES) if (window.matchMedia(q).matches) return layout;
  return "desktop";
}

function subscribe(onChange: () => void): () => void {
  const lists = QUERIES.map(([, q]) => window.matchMedia(q));
  lists.forEach((l) => l.addEventListener("change", onChange));
  return () => lists.forEach((l) => l.removeEventListener("change", onChange));
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, current, () => "desktop");
}
