---
name: commit-message
description: Write a conventional commit message from the staged diff.
metadata:
  version: 0.3.1
  author: Tools Guild
---

# Commit message

Read the staged changes with `scripts/staged.sh`, then propose a message in the form `type(scope): summary`.
Keep the summary under 72 characters and explain why in the body.
