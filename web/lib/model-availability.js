/** Missing availability retains the catalogue's existing behaviour. */
export const modelUnavailable = model => model?.availability === "temporarily_unavailable";
export const selectableModels = models => models.filter(model => !modelUnavailable(model));
export const availabilityFields = model => modelUnavailable(model) ? { availability: model.availability } : {};
export const balanceDisplay = value => value == null ? "Unknown" : String(value);
