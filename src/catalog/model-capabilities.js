// Pure vocabulary shared by the router and browser. Rates alone never imply a modality.
export const LONG_CONTEXT_TOKENS = 128_000;
export const MODEL_CAPABILITIES = [
  { key: "vision", label: "Reads images", explanation: "Accepts images alongside text; image input is declared by the provider." },
  { key: "imageOut", label: "Makes images", explanation: "Returns images; catalogue rates may include token and image charges." },
  { key: "audio", label: "Audio", explanation: "Accepts or returns audio; browser speech works separately from model audio." },
  { key: "tools", label: "Tools", explanation: "Can request tool calls; the calling app must run the tools and return their results." },
  { key: "longContext", label: "Long context", explanation: "Lists a context window of at least 128,000 tokens; the chosen provider may have a lower limit." },
  { key: "attested", label: "Proven hardware", explanation: "Has an endpoint with a fresh hardware attestation checked by the router; this does not prove answer quality or encrypt ordinary chat." },
  { key: "network", label: "Anyroute network", explanation: "Has a live offer on an Anyroute network host for a model admitted on that host; routing may choose another provider.", href: "/network/" },
  { key: "encrypted", label: "Encrypted chat", explanation: "Available through the separate device-encryption gateway setup; ordinary Harness chat still sends readable requests to the router.", href: "/docs/#e2ee-phala" },
];

export function modelModalities(model, direction = "input") {
  if (!model) return [];
  const declared = model.architecture?.[`${direction}_modalities`] ?? model[`${direction}_modalities`] ?? model[direction === "input" ? "inputs" : "outputs"];
  if (Array.isArray(declared)) return declared;
  const modality = model.architecture?.modality;
  return typeof modality === "string" && modality.includes("->") ? modality.split("->")[direction === "input" ? 0 : 1].split("+") : ["text"];
}

export function deriveCapabilities(model = {}) {
  const inputs = modelModalities(model, "input"), outputs = modelModalities(model, "output");
  const params = model.supported_parameters ?? model.params ?? [];
  const hasParam = (key) => params instanceof Set ? params.has(key) : Array.isArray(params) && params.includes(key);
  const proven = model.attested_available === true || (model.attested_available == null && (model.disclosure?.best === "attested" || model.attested === true));
  const flags = {
    vision: inputs.includes("image"), imageOut: outputs.includes("image"), audio: inputs.includes("audio") || outputs.includes("audio"), tools: hasParam("tools"),
    longContext: Number(model.context_length ?? model.contextLength ?? model.context ?? model.top_provider?.context_length ?? 0) >= LONG_CONTEXT_TOKENS,
    attested: proven,
    network: model.network_host_available === true,
    // Never infer encryption from attestation, a lane, a price or a model/provider name.
    encrypted: model.encrypted_chat_available === true,
  };
  return MODEL_CAPABILITIES.filter((tag) => flags[tag.key]).map((tag) => tag.key);
}

// A new router's list is authoritative; older responses derive only what their fields establish.
export function modelCapabilities(model) {
  return Array.isArray(model?.capabilities)
    ? MODEL_CAPABILITIES.filter((tag) => model.capabilities.includes(tag.key)).map((tag) => tag.key)
    : deriveCapabilities(model ?? {});
}
export const hasModelCapability = (model, key) => modelCapabilities(model).includes(key);
