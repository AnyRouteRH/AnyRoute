// D140: supplement to the existing encrypted Chat history browser-storage entry.
export const savedAnswersBrowser = {
  store: "IndexedDB",
  holds: "The optional savedAnswers field in the existing anyroute-private-history encrypted vault holds separate copies of reply text, preceding question text, model, reported cost (or null), save date, receipt ID (or empty), chat ID, message ID and a deduplication ID. It uses the existing passphrase-derived key and serial write queue; there is no new browser database or router store. The collection is limited to 256,000 UTF-8 bytes and 1,000 entries. It survives deleting or trimming chats. Searching uses decrypted questions and answers in memory while history is unlocked. Locking discards decrypted answers; Forget deletes them with the vault. Without IndexedDB, storage lasts only for the tab. Existing history exports and imports include saved answers, including copies whose chats were deleted; downloads are readable text. Reply text excludes images, attachments, reasoning and tool results. This does not change the router's in-memory reading of requests.",
  evidence: [
    { file: "web/lib/saved-answers.js", contains: "await seal(s, s.chats, s.prompts, savedAnswers);" },
    { file: "web/lib/private-history.js", contains: "savedAnswers = s.savedAnswers" },
  ],
};
