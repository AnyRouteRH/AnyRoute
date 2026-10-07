// C131: the arrival date is separate from a model's upstream release date.
export const NEW_MODELS_FILTER = "newThisWeek";
export function isNewModel(model, days = 7, now = Date.now() / 1000) {
  const added = model?.added_at;
  return Number.isSafeInteger(added) && added > 0 && added <= now && now - added < days * 86400;
}
export function newModels(models, now = Date.now() / 1000) {
  return models.filter(model => isNewModel(model, 7, now)).sort((a, b) => b.added_at - a.added_at || a.id.localeCompare(b.id)).slice(0, 6);
}
export function newModelRates(model) {
  const rate = (field, normalized) => {
    const value = model.pricing?.[field];
    const n = value == null ? model[normalized] : Number(value) * 1e6;
    return Number.isFinite(n) && n >= 0 ? "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "Not listed";
  };
  return { input: rate("prompt", "inPrice"), output: rate("completion", "outPrice") };
}
