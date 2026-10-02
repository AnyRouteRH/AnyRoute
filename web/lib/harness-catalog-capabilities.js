import { MODEL_CAPABILITIES, modelCapabilities } from "./model-capabilities.js";

// Existing saved filters for files/reasoning/JSON/search still work. Shared tags use the API's authoritative list.
export function catalogHasCapability(model, key) {
  return MODEL_CAPABILITIES.some(tag => tag.key === key) ? modelCapabilities(model).includes(key) : !!model.caps?.has(key);
}
