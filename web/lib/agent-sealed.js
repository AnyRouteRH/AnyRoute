export function sealedLabel(sealed, now = Date.now()) {
  if (!sealed?.attested || !Number.isFinite(Date.parse(sealed.expires_at)) || Date.parse(sealed.expires_at) <= now || !/^sha256:[a-f0-9]{64}$/.test(sealed.agent_image_digest || '')) return null;
  return 'Sealed · attested · image ' + sealed.agent_image_digest;
}
