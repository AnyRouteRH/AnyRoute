"use client";
// G156: version controls share the existing edit and resend actions.
import { createContext, useContext, useEffect, useRef } from "react";
import { messageVersions, switchVersion } from "../../lib/harness-branches.js";
import s from "./Branches.module.css";

const Branches = createContext(null);
const Lane = createContext(null);
export function BranchLane({ laneId, onInteract, children }) {
  return <Lane.Provider value={laneId}><div className={s.lane} onClickCapture={onInteract}>{children}</div></Lane.Provider>;
}

export function BranchProvider({ lanes, setLanes, busy, beforeSwitch, children }) {
  const pendingFocus = useRef(null);
  return <Branches.Provider value={{ lanes, busy, pendingFocus, switchTo: (laneId, messageId, targetId, direction) => {
    if (busy) return;
    pendingFocus.current = { laneId, messageId: targetId, direction };
    beforeSwitch();
    setLanes(current => current.map(lane => lane.id === laneId ? switchVersion(lane, messageId, targetId) : lane));
  } }}>{children}</Branches.Provider>;
}

export function BranchVersions({ messageId }) {
  const branch = useContext(Branches);
  const laneId = useContext(Lane);
  const lane = branch?.lanes.find(lane => (!laneId || lane.id === laneId) && lane.messages.some(message => message.id === messageId));
  const versions = lane && messageVersions(lane, messageId);
  const controls = useRef(null);
  useEffect(() => {
    const pending = branch?.pendingFocus.current;
    if (!pending || pending.messageId !== messageId || pending.laneId !== lane?.id || !controls.current) return;
    const buttons = [...controls.current.querySelectorAll("button")];
    const requested = buttons[pending.direction < 0 ? 0 : 1];
    (requested?.disabled ? buttons.find(button => !button.disabled) : requested)?.focus({ preventScroll: true });
    branch.pendingFocus.current = null;
  }, [branch, lane?.id, messageId]);
  if (!versions) return null;
  return <nav ref={controls} className={s.versions} aria-label="Message versions">
    <button type="button" aria-label="Previous message version" disabled={branch.busy || versions.index === 0} onClick={() => branch.switchTo(lane.id, messageId, versions.ids[versions.index - 1], -1)}>‹</button>
    <span role="status" aria-live="polite">{versions.index + 1} / {versions.ids.length}</span>
    <button type="button" aria-label="Next message version" disabled={branch.busy || versions.index === versions.ids.length - 1} onClick={() => branch.switchTo(lane.id, messageId, versions.ids[versions.index + 1], 1)}>›</button>
  </nav>;
}
