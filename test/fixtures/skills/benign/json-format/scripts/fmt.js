const fs = require("node:fs");
const path = process.argv[2];
try {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  console.log("formatted", path);
} catch (error) {
  console.error("invalid JSON:", error.message);
  process.exitCode = 1;
}
