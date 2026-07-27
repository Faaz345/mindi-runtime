export type ActivePanel = "none" | "inspector" | "logs" | "graph" | "palette" | "model-picker";

/** Keys that dismiss an active panel before reaching terminal input. */
export function closesPanel(panel: ActivePanel, key: { escape?: boolean; tab?: boolean; return?: boolean; ctrl?: boolean }, input: string): boolean {
  if (panel === "none" || panel === "model-picker") return false;
  return Boolean(key.escape || key.tab || (key.ctrl && input === "c") || (panel === "palette" && key.return));
}
