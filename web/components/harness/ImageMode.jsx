"use client";
import { imageOutput, imagePrice } from "../../lib/harness-images";
import { formatPrice } from "../../lib/harness";
import s from "./Images.module.css";

export default function ImageMode({ model, lanes, find, catalogue, enabled, busy, onChange, onChoose }) {
  const active = imageOutput(model) && enabled;
  const outputs = lanes.map((lane) => find(lane.modelId)).filter(imageOutput);
  return (
    <div className={s.mode}>
      <button type="button" className={s.toggle} aria-pressed={active} disabled={busy} onClick={() => imageOutput(model) ? onChange(!enabled) : onChoose()}>
        Image <span aria-hidden="true">{active ? "●" : "+"}</span>
      </button>
      {enabled && outputs.map((m) => (
        <p className={s.price} key={m.id}>
          {lanes.length > 1 && <b>{m.name}: </b>}
          {imagePrice(catalogue?.find((raw) => raw.id === m.id))}
          {" "}{formatPrice(m.inPrice)} in / {formatPrice(m.outPrice)} out per million tokens.
        </p>
      ))}
      {active && <p className={s.hint}>Generated images stay in this chat. Private mode's unlocked browser history can keep them across visits; larger chats may exceed its storage limit. Image links can expire.</p>}
    </div>
  );
}
