"use client";
import { useState } from "react";
import { imageFile, safeImageUrl } from "../../lib/harness-images";
import s from "./Images.module.css";

export default function GeneratedImages({ images, busy, onUse }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function action(url, index, use) {
    setPending(true);
    setError("");
    try {
      const file = await imageFile(url, index);
      if (use) await onUse([file]);
      else {
        const objectUrl = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (e) {
      setError(e.message || "The image could not be opened.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={s.gallery}>
      {images.map((url, index) => {
        const safe = safeImageUrl(url);
        return safe && <figure key={index} className={s.image}>
          <img src={safe} alt={`Generated image ${index + 1}`} referrerPolicy="no-referrer" />
          <figcaption>
            <button type="button" className="text-button" disabled={pending} onClick={() => action(safe, index, false)} aria-label={`Download generated image ${index + 1}`}>Download</button>
            {onUse && <button type="button" className="text-button" disabled={busy || pending} onClick={() => action(safe, index, true)} aria-label={`Use generated image ${index + 1} as input`}>Use as input</button>}
          </figcaption>
        </figure>;
      })}
      {pending && <p className={s.hint} role="status">Opening image…</p>}
      {error && <p className={s.error} role="alert">{error}</p>}
    </div>
  );
}
