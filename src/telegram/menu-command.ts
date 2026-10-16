// J179: process-local delegation metadata; commands retain their own link locks and guards.
import type { TgUpdate } from "../services/telegram.ts";
import type { Link } from "./linking.ts";

export const MENU_COMMANDS = [{ command: "menu", description: "Open balance, agents, approvals, inbox and settings" }];
export const MENU_HELP = "/menu  open balance, agents, waiting approvals, inbox and settings";
const generations = new WeakMap<TgUpdate, string>();
export function bindMenuCommand(update: TgUpdate, generation: string) {
  generations.set(update, generation);
  return update;
}
export function menuLinkMatches(update: TgUpdate, link: Link | undefined) {
  const generation = generations.get(update);
  return generation === undefined || link?.generation === generation;
}
export const STALE_MENU = "This menu has expired. Send /menu again.";
