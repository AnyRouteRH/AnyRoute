"use client";
// K191: reuse the selected BranchLane and Chat's existing state and encrypted history.
import { createContext, useContext, useRef } from 'react';
import { useBranchLane } from './Branches';
import { jumpToPinnedMessage, pinAnchor, pinnedMessages, toggleMessagePin } from '../../lib/message-pins.js';
import s from './MessagePins.module.css';

const Pins = createContext(null);
export function MessagePinsProvider({ lanes, setLanes, busy, children }) {
  return <Pins.Provider value={{ lanes, busy, toggle: (laneId, messageId) => {
    if (!busy) setLanes(current => current.map(lane => lane.id === laneId ? toggleMessagePin(lane, messageId) : lane));
  } }}>{children}</Pins.Provider>;
}

export function MessagePinMenu({ message }) {
  const pins = useContext(Pins), laneId = useBranchLane(), menu = useRef(null);
  if (!pins || !laneId) return null;
  return <div className={s.message} id={pinAnchor(laneId, message.id)}>
    {message.pinned === true && <span className={s.marker}>Pinned</span>}
    <details ref={menu} className={s.menu} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); menu.current.open = false; menu.current.querySelector('summary').focus(); }
    }}>
      <summary aria-label={`${message.role === 'user' ? 'Your message' : 'Reply'} menu`}>Message menu</summary>
      <button type="button" disabled={pins.busy} onClick={() => {
        pins.toggle(laneId, message.id); menu.current.open = false; menu.current.querySelector('summary').focus();
      }}>{message.pinned === true ? 'Unpin message' : 'Pin message'}</button>
    </details>
  </div>;
}

export function MessagePinsStrip() {
  const pins = useContext(Pins), laneId = useBranchLane();
  const lane = pins?.lanes.find(lane => lane.id === laneId), messages = pinnedMessages(lane);
  if (!messages.length) return null;
  return <nav className={s.strip} aria-label="Pinned messages">
    <span className={s.count} role="status">Pinned · {messages.length}</span>
    <ul>{messages.map(message => <li key={message.id}>
      <button type="button" className={s.jump} onClick={() => jumpToPinnedMessage(document, laneId, message.id)} title={message.text?.slice(0, 300)}>
        {message.role === 'user' ? 'You' : 'Reply'} · {message.text?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Message without text'}
      </button>
      <button type="button" disabled={pins.busy} aria-label={`Unpin ${message.role === 'user' ? 'your message' : 'reply'}: ${message.text?.slice(0, 50) || 'message without text'}`} onClick={event => {
        const next = event.currentTarget.closest('li').nextElementSibling || event.currentTarget.closest('li').previousElementSibling;
        (next?.querySelector('button') || document.getElementById(pinAnchor(laneId, message.id))?.querySelector('summary'))?.focus();
        pins.toggle(laneId, message.id);
      }}>Unpin</button>
    </li>)}</ul>
  </nav>;
}

export function PrintedPin({ pinned }) {
  return pinned ? <p>Pinned</p> : null;
}
