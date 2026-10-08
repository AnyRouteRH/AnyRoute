import { validateSavedAnswers } from "./saved-answers.js";
import { validateFolders } from "./chat-folders.js";

// Named metadata carries both features. Keep the array argument accepted by either earlier feature.
export function historyMetadata(value = [], folders = []) {
  const metadata = Array.isArray(value)
    ? value.length && Object.hasOwn(value[0] || {}, "name")
      ? { folders: value }
      : { savedAnswers: value, folders }
    : value;
  if (!metadata || typeof metadata !== "object") throw new Error("Choose valid history metadata.");
  return {
    savedAnswers: validateSavedAnswers(metadata.savedAnswers),
    folders: validateFolders(metadata.folders),
  };
}
