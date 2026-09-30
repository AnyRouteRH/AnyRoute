import type { SkillFile } from "./archive.ts";

// The skill scanner: static rules over every file of a skill, looking for what a malicious agent skill does. It reads text line
// by line (and binaries by their magic bytes) and never runs anything. Rules:
//
//   exfil.*        network calls to hosts outside the allowlist; secrets or env values put into a network call; reading SSH
//                  keys, cloud credentials, keychains or browser profiles; dumping the environment; any of those plus a call
//                  out in the same file (exfil.chain)
//   exec.*         decode-then-eval (base64, hex, zlib), piping a download into a shell, dynamic eval
//   injection.*    prompt injection in SKILL.md and resources: "ignore previous instructions", role hijacks, instructions to
//                  hide things from the user or to send secrets somewhere, zero-width and bidi characters, Unicode tag
//                  characters (ASCII smuggling), instructions hidden in HTML comments
//   obfuscation.*  long base64 or hex blobs, escaped shellcode, packed or minified code
//   shell.*        rm -rf on / or ~, chmod 777, sudo, persistence (cron, launchd, systemd, shell rc files, git hooks),
//                  turning off OS security or TLS checks, reverse shells
//   deps.*         installing packages from an index or registry outside the default ones, from URLs, or with install hooks
//   binary.*       executables, nested archives and other binary files; archive.symlink for symlinks
//
// Score: 100 minus a weight per distinct (rule, file): low 3, medium 10, high 25, critical 50, floored at 0.
// Level: dangerous with any high or critical finding or a score under 40; caution with any medium finding or a score under 90;
// trusted otherwise. Scanned, not guaranteed: a rule set catches known patterns, not every attack.

export const SCANNER_VERSION = "skillscan/1";
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const LEVELS = ["trusted", "caution", "dangerous"] as const;
export type Level = (typeof LEVELS)[number];
export type Finding = { rule: string; file: string; line: number | null; excerpt: string; severity: Severity; message: string };
export type ScanReport = {
  scanner: string;
  score: number;
  level: Level;
  summary: Record<Severity, number>;
  findings: Finding[];
  truncated: boolean;
  files_scanned: number;
  bytes_scanned: number;
  note: string;
};

export const SCAN_NOTE = "Scanned, not guaranteed: static rules flag known patterns of exfiltration, prompt injection, obfuscation and dangerous commands. A clean result is not proof that a skill is safe.";
export const DEFAULT_ALLOWED_HOSTS = [
  "localhost", "127.0.0.1", "github.com", "api.github.com", "raw.githubusercontent.com", "gitlab.com", "pypi.org", "files.pythonhosted.org",
  "registry.npmjs.org", "npmjs.com", "huggingface.co", "wikipedia.org", "example.com", "docs.python.org", "developer.mozilla.org",
];

const WEIGHT: Record<Severity, number> = { info: 0, low: 3, medium: 10, high: 25, critical: 50 };
const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const MAX_FINDINGS = 200;
const PER_RULE_FILE = 3;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CHUNK = 4000;

type Rule = { id: string; severity: Severity; message: string; re: RegExp; code?: boolean; md?: boolean };

const CODE_EXT = /\.(sh|bash|zsh|fish|ksh|py|pyw|js|mjs|cjs|ts|mts|cts|jsx|tsx|rb|pl|php|ps1|psm1|bat|cmd|go|rs|lua|swift|applescript|scpt|vbs|java|kt|cs)$/i;
const MD_EXT = /\.(md|markdown|mdx|txt|rst)$/i;
const MINIFIABLE = /\.(js|mjs|cjs|ts|py|sh|php|rb|pl)$/i;

// ---------------------------------------------------------------------------------------------------------------------
// rules applied to each line (each is tried on every line of every text file, or only on code lines when `code` is set)

const SECRET_FILES =
  /(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\bhomedir\(\))[\/\\]+\.(ssh|aws|gnupg|kube|docker|azure|netrc|git-credentials|npmrc|pypirc)\b|["'`]\.(ssh|aws|gnupg|kube|netrc|git-credentials)["'`\/]|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.aws\/credentials\b|\.ssh\/(authorized_keys|known_hosts|config)\b|\.config\/(solana|gcloud|gh\/hosts\.yml)|\bwallet\.dat\b|\bkeystore\/UTC--/;
const KEYCHAIN = /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export|unlock-keychain)\b|\blogin\.keychain(-db)?\b|Library\/Keychains|\bkeyring\.get_password\b|\bsecret-tool\s+lookup\b|\bkwallet(-query)?\b|\bCredRead\b|\bcmdkey\s+\/list\b|\bGet-StoredCredential\b/;
const BROWSER =
  /(Google\/Chrome|google-chrome\/|Chromium\/|BraveSoftware|Microsoft\/Edge|Mozilla\/Firefox|\.mozilla\/firefox|Firefox\/Profiles|Library\/Safari|Application Support\/(Google|BraveSoftware|Arc|Firefox))|\b(Login Data|Web Data|Local State)\b|\bcookies\.sqlite\b|\blogins\.json\b|\bkey[34]\.db\b|Local Extension Settings|nkbihfbeogaeaoehlefnkodbefgpgknn/;
const ENV_DUMP =
  /(^|[;&|(`]\s*|\$\(\s*)(printenv|env)\s*($|[>|;)`])|JSON\.stringify\(\s*process\.env\s*[,)]|json\.dumps\(\s*(dict\(\s*)?os\.environ\s*\)?\s*[,)]|\bdict\(\s*os\.environ\s*\)|Object\.(entries|keys|values)\(\s*process\.env\s*\)|\bfor\s+\w+(\s*,\s*\w+)?\s+in\s+os\.environ(\.items\(\))?\s*:|Get-ChildItem\s+env:|\bgci\s+env:|\bexport\s+-p\b|\bdeclare\s+-x\b/;

const LINE_RULES: Rule[] = [
  { id: "exfil.secret_files", severity: "high", message: "Reads SSH keys, cloud credentials or other secret files.", re: SECRET_FILES },
  { id: "exfil.keychain", severity: "high", message: "Reads the system keychain or a credential store.", re: KEYCHAIN },
  { id: "exfil.browser_data", severity: "high", message: "Reads browser profiles, cookies, saved logins or wallet extensions.", re: BROWSER },
  { id: "exfil.env_dump", severity: "high", message: "Dumps every environment variable (where API keys live).", re: ENV_DUMP, code: true },
  {
    id: "exec.decode_eval",
    severity: "critical",
    message: "Decodes a hidden payload and runs it.",
    re: /base64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\|\s*base64\s+(-d|--decode|-D)\s*\|\s*(sudo\s+)?((ba|z|da|k)?sh|python\d?|perl|node|ruby)\b|\b(eval|exec|Function)\s*\([^\n]{0,40}(atob\s*\(|b64decode|b32decode|a85decode|fromhex|unhexlify|decompress\s*\(|marshal\.loads|codecs\.decode|Buffer\.from\([^)]*['"](base64|hex)['"])|\bexec\s*\(\s*__import__\s*\(\s*['"](base64|zlib|codecs|marshal)['"]|\bpowershell\b[^\n]*-(e|enc|encodedcommand)\s+[A-Za-z0-9+\/=]{20,}|\bxxd\s+-r\b[^\n]*\|\s*(ba|z)?sh\b/i,
  },
  {
    id: "exec.remote_pipe",
    severity: "critical",
    message: "Downloads a script and pipes it straight into an interpreter.",
    re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(sudo\s+)?((ba|z|da|k|fi)?sh|python\d?|perl|ruby|node|php|iex)\b|\bIEX\s*\(\s*(New-Object\s+Net\.WebClient|iwr|irm)|\b(ba|z)?sh\s+<\(\s*(curl|wget)|\bpython\d?\s+<\(\s*(curl|wget)|\beval\s+"?\$\(\s*(curl|wget)/i,
  },
  { id: "exec.dynamic", severity: "medium", message: "Evaluates code built at run time.", re: /(?<![.\w$])(eval|exec)\s*\(|\bnew\s+Function\s*\(/, code: true },
  {
    id: "injection.override",
    severity: "high",
    message: "Prompt injection: tells the agent to ignore its instructions.",
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|your|system|safety|developer|original|initial|all\s+(previous|prior|other))\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|directives|guardrails|polic(y|ies))\b/i,
  },
  {
    id: "injection.role_hijack",
    severity: "high",
    message: "Prompt injection: rewrites the agent's role or system prompt.",
    re: /\byou\s+are\s+now\b[^.\n]{0,30}\b(DAN|unrestricted|jailbroken|developer mode|no longer bound|free of)|\b(new|updated|real|true)\s+system\s+prompt\s*:|\benter(ing)?\s+(developer|god|jailbreak)\s+mode\b|<\|im_start\|>|<\/?im_(start|end)>|\[\/?INST\]/i,
  },
  {
    id: "injection.conceal",
    severity: "high",
    message: "Prompt injection: tells the agent to hide what it does from the user.",
    re: /\b(do\s+not|don't|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?|alert(ing)?|notify(ing)?|reveal(ing)?|ask(ing)?)\b[^.\n]{0,25}\b(the\s+)?(user|human|operator|owner)\b|\bsilently\b[^.\n]{0,40}\b(send|upload|post|execute|install|copy|transmit|forward)\b|\bkeep\s+this\s+(secret|hidden)\s+from\b/i,
  },
  {
    id: "injection.exfiltrate",
    severity: "critical",
    message: "Prompt injection: instructs the agent to send secrets somewhere.",
    re: /\b(send|upload|post|exfiltrate|transmit|forward|copy|leak|share|email|paste)\b[^.\n]{0,80}\b(api[\s_-]?keys?|secrets?|credentials?|tokens?|passwords?|private[\s_-]?keys?|ssh[\s_-]?keys?|\.env\b|environment\s+variables|env\s+vars|seed\s+phrases?|mnemonics?|cookies|wallet)[^.\n]{0,80}\b(to|at|via|into)\b\s*(https?:\/\/|[\w-]+(\.[\w-]+)+|(a\s+|the\s+|this\s+)?(webhook|pastebin|discord|telegram|gist|url|endpoint|server))|\bexfiltrat(e|es|ed|ing|ion)\b/i,
  },
  { id: "injection.tool_poisoning", severity: "medium", message: "Hidden-instruction tags aimed at the model.", re: /<\s*(IMPORTANT|SYSTEM|INSTRUCTIONS?|HIDDEN|SECRET)\s*>/ },
  { id: "obfuscation.base64_blob", severity: "medium", message: "A long base64 blob that hides what it contains.", re: /(?<!data:[\w.+\/-]{1,40};base64,)(?<![A-Za-z0-9+\/])[A-Za-z0-9+\/]{160,}={0,2}/ },
  { id: "obfuscation.hex_blob", severity: "high", message: "Escaped bytes or a long hex blob (shellcode-like).", re: /(\\x[0-9a-fA-F]{2}){16,}|(\b0x[0-9a-fA-F]{2}\s*,\s*){32,}|(?<![0-9a-fA-F])[0-9a-fA-F]{256,}(?![0-9a-fA-F])|(\\u00[0-9a-fA-F]{2}){20,}/ },
  {
    id: "obfuscation.packed",
    severity: "high",
    message: "Packed or deliberately obfuscated code.",
    re: /eval\(function\(p,a,c,k,e,[dr]\)|\b_0x[0-9a-f]{4,6}\b[^\n]*\b_0x[0-9a-f]{4,6}\b[^\n]*\b_0x[0-9a-f]{4,6}\b|String\.fromCharCode\(\s*(\d+\s*,\s*){15,}|(\bchr\(\s*\d+\s*\)\s*\+\s*){10,}/i,
  },
  {
    id: "shell.rm_root",
    severity: "critical",
    message: "Recursively deletes the root, the home directory or a system directory.",
    re: /\brm\s+(-[a-zA-Z]+\s+|--[a-z-]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(-[a-zA-Z]+\s+|--[a-z-]+\s+)*("?(\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?|\/(etc|usr|bin|sbin|var|System|Users|home|Library)\/?)"?)(\s|$|;|&|\|)|--no-preserve-root|\brmtree\(\s*(['"]\/['"]|os\.path\.expanduser\(\s*['"]~['"]\s*\)|Path\.home\(\))|\bRemove-Item\b[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE|~)/,
  },
  { id: "shell.chmod_world", severity: "medium", message: "Makes files writable by everyone.", re: /\bchmod\s+(-R\s+)?(0?777|a\+rwx|ugo\+rwx|o\+w)\b/ },
  { id: "shell.sudo", severity: "medium", message: "Runs commands as root.", re: /(^|[\s;&|`(])(sudo|doas)\s+[-\w\/]/, code: true },
  {
    id: "shell.persistence",
    severity: "high",
    message: "Installs itself to run again later (cron, launchd, systemd, shell startup files, git hooks, Run keys).",
    re: /\bcrontab\b|\blaunchctl\s+(load|bootstrap|submit|enable)\b|Library\/Launch(Agents|Daemons)|\bsystemctl\s+(--user\s+)?enable\b|\/etc\/(rc\.local|cron\.|init\.d\/|systemd\/)|>>?\s*["']?(~|\$HOME|\$\{HOME\})\/\.(bashrc|zshrc|bash_profile|profile|zprofile|zshenv|config\/fish\/config\.fish)\b|\bschtasks\s+\/create\b|CurrentVersion\\Run\b|\.git\/hooks\/|\bLoginItems\b/i,
  },
  {
    id: "shell.security_off",
    severity: "high",
    message: "Turns off an operating-system security control.",
    re: /\bspctl\s+--master-disable\b|\bcsrutil\s+disable\b|\bxattr\s+(-r\s+)?-(r?d|c)\b[^\n]*quarantine|\bsetenforce\s+0\b|\bufw\s+disable\b|\bSet-MpPreference\s+-Disable|\bSet-ExecutionPolicy\s+(Unrestricted|Bypass)\b|\bdefaults\s+write\s+com\.apple\.LaunchServices\s+LSQuarantine\b/i,
  },
  { id: "shell.tls_off", severity: "medium", message: "Turns off TLS certificate checks.", re: /http\.sslVerify\s+false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|\bcurl\b[^\n]*\s(-k|--insecure)\b/ },
  {
    id: "shell.reverse_shell",
    severity: "critical",
    message: "Opens a reverse shell.",
    re: /\/dev\/(tcp|udp)\/|\bnc(at)?\s+[^\n]*\s-[a-z]*[ec]\s|\bbash\s+-i\s*>&|\bsocat\b[^\n]*\bexec:|\bmkfifo\b[^\n]*\bnc\b|\bpty\.spawn\(\s*['"]\/bin\/(ba)?sh/,
  },
  { id: "deps.install_hook", severity: "high", message: "A package install hook runs code when the dependency is installed.", re: /"(pre|post)?install"\s*:\s*"/ },
  { id: "deps.url_install", severity: "medium", message: "Installs a package from a URL or a git repository instead of a registry.", re: /\b(pip3?|uv\s+pip|pipx)\s+install\b[^\n]*\s(https?:\/\/|git\+)|\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b[^\n]*\s(https?:\/\/|git\+|git:\/\/|github:)/ },
];

// Package indexes and registries that count as the defaults (anything else in --index-url, --registry or .npmrc is flagged).
const DEFAULT_INDEXES = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com"];
const INDEX_RE = /(?:--index-url|--extra-index-url|--registry|--find-links)[=\s]+["']?([^\s"']+)|\b(?:pip3?|uv\s+pip)\s+install\b[^\n]*\s-i\s+["']?([^\s"']+)|^\s*(?:@[\w-]+:)?registry\s*=\s*([^\s"']+)|\bnpm\s+config\s+set\s+(?:@[\w-]+:)?registry\s+([^\s"']+)|--trusted-host[=\s]+([^\s"']+)/;
const NET_CALL =
  /\b(curl|wget|aria2c|httpie)\b(?=\s)|\bfetch\s*\(|\brequests\.(get|post|put|patch|delete|head|request)\s*\(|\bhttpx\.(get|post|put|patch|delete|request|Client|AsyncClient)\b|\burllib(3)?\.request\b|\burlopen\s*\(|\baxios(\.\w+)?\s*\(|\b(https?|net|tls)\.(request|get|connect)\s*\(|\bInvoke-(WebRequest|RestMethod)\b|\b(iwr|irm)\s|\bnc(at)?\s+(-\w+\s+)*[\w.-]+\s+\d{2,5}\b|\bsocket\.(connect|create_connection)\b|new\s+WebSocket\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(|\bscp\s+\S+\s+\S+@\S+:|\bsmtplib\.SMTP\b|\bnslookup\s+\S*\$|\bdig\s+\S*\$/;
const SECRET_REF =
  /\$\{?[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE)[A-Z0-9_]*\}?|process\.env\b|os\.environ\b|os\.getenv\s*\(|\bgetenv\s*\(|\bENV\[|\$\(\s*(cat|env|printenv|security|whoami|hostname|history)\b|`\s*(cat|env|printenv|security)\s|\$\(<|\bDeno\.env\b|\bBun\.env\b|\bSystem\.getenv\b|\$env:[A-Za-z_]+/;
const URL_RE = /\b(?:https?|wss?|ftp):\/\/([^\s\/'"`<>)\]}?#]*)/gi;

const HIDDEN = /[\u200b-\u200f\u2060-\u2064\u202a-\u202e\u2066-\u2069\u00ad\u180e]|\ufeff/g;
const TAGS = /[\u{e0000}-\u{e007f}]/gu;

// ---------------------------------------------------------------------------------------------------------------------

const visible = (s: string) =>
  s
    .replace(TAGS, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
    .replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
export const excerptOf = (line: string, at = 0) => {
  const v = visible(line.trim());
  if (v.length <= 160) return v;
  const start = Math.max(0, Math.min(at - 40, v.length - 160));
  return (start > 0 ? "..." : "") + v.slice(start, start + 157) + "...";
};

export function hostAllowed(host: string, allowed: readonly string[]) {
  const h = host.toLowerCase().replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h || /[${}%]/.test(h)) return false;
  return allowed.some((a) => h === a || h.endsWith("." + a));
}

function hostsOn(line: string) {
  const hosts: string[] = [];
  for (const m of line.matchAll(URL_RE)) hosts.push(m[1] || "$dynamic");
  return hosts;
}

const MAGIC: { name: string; rule: "binary.executable" | "binary.archive" | "binary.asset"; bytes: number[] }[] = [
  { name: "ELF executable", rule: "binary.executable", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Mach-O executable", rule: "binary.executable", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O executable", rule: "binary.executable", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O executable", rule: "binary.executable", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "Mach-O universal binary or Java class", rule: "binary.executable", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "Windows executable", rule: "binary.executable", bytes: [0x4d, 0x5a] },
  { name: "WebAssembly module", rule: "binary.executable", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { name: "zip archive", rule: "binary.archive", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "gzip archive", rule: "binary.archive", bytes: [0x1f, 0x8b] },
  { name: "7z archive", rule: "binary.archive", bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { name: "PNG image", rule: "binary.asset", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "JPEG image", rule: "binary.asset", bytes: [0xff, 0xd8, 0xff] },
  { name: "GIF image", rule: "binary.asset", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "PDF document", rule: "binary.asset", bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: "WOFF font", rule: "binary.asset", bytes: [0x77, 0x4f, 0x46, 0x46] },
  { name: "WOFF2 font", rule: "binary.asset", bytes: [0x77, 0x4f, 0x46, 0x32] },
];
const BINARY_SEVERITY = { "binary.executable": "critical", "binary.archive": "medium", "binary.asset": "low", "binary.unknown": "medium" } as const;

function isBinary(data: Uint8Array) {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, MAX_TEXT_BYTES));
    return false;
  } catch {
    // A cut in the middle of a multi-byte character at the size cap is not binary; anything else is.
    return data.length <= MAX_TEXT_BYTES;
  }
}

export type ScanOptions = { allowedHosts?: readonly string[] };

export function scanSkill(files: SkillFile[], opts: ScanOptions = {}): ScanReport {
  const allowed = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const all: Finding[] = [];
  let bytes = 0;
  const add = (rule: string, severity: Severity, file: string, line: number | null, excerpt: string, message: string) => all.push({ rule, file, line, excerpt, severity, message });

  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    bytes += f.data.length;
    if (f.type === "symlink") {
      const escapes = (f.target ?? "").startsWith("/") || (f.target ?? "").split("/").includes("..");
      add("archive.symlink", escapes ? "critical" : "high", f.path, null, `-> ${excerptOf(f.target ?? "")}`, escapes ? "A symlink that points outside the skill (it can expose any file on the machine)." : "A symlink inside the skill.");
      continue;
    }
    if (isBinary(f.data)) {
      const m = MAGIC.find((x) => x.bytes.every((b, i) => f.data[i] === b));
      const rule = m?.rule ?? "binary.unknown";
      add(rule, BINARY_SEVERITY[rule], f.path, null, m ? m.name : `${f.data.length} bytes of binary data`, rule === "binary.executable" ? "A compiled executable: its behaviour cannot be read." : rule === "binary.archive" ? "A nested archive that was not unpacked or scanned." : rule === "binary.asset" ? "A binary asset (image, PDF or font)." : "A binary file that could not be scanned as text.");
      continue;
    }
    scanText(f, allowed, add);
  }

  // One finding per (rule, file) counts toward the score, the first few are reported.
  const seen = new Map<string, number>();
  const counted = new Set<string>();
  let score = 100;
  const summary: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const findings: Finding[] = [];
  let truncated = false;
  all.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  for (const x of all) {
    summary[x.severity]++;
    const k = `${x.rule}\u0000${x.file}`;
    if (!counted.has(k)) { counted.add(k); score -= WEIGHT[x.severity]; }
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > PER_RULE_FILE || findings.length >= MAX_FINDINGS) { truncated = true; continue; }
    findings.push(x);
  }
  score = Math.max(0, score);
  const level: Level = summary.critical || summary.high || score < 40 ? "dangerous" : summary.medium || score < 90 ? "caution" : "trusted";
  return { scanner: SCANNER_VERSION, score, level, summary, findings, truncated, files_scanned: files.length, bytes_scanned: bytes, note: SCAN_NOTE };
}

type Add = (rule: string, severity: Severity, file: string, line: number | null, excerpt: string, message: string) => void;

function scanText(f: SkillFile, allowed: readonly string[], add: Add) {
  const text = new TextDecoder().decode(f.data.subarray(0, MAX_TEXT_BYTES));
  const isCodeFile = CODE_EXT.test(f.path) || text.startsWith("#!") || (!/\.[a-z0-9]+$/i.test(f.path) && (f.mode & 0o111) !== 0);
  const isMd = MD_EXT.test(f.path) || f.path === "SKILL.md";
  const isPkgJson = /(^|\/)package\.json$/.test(f.path);
  const isDepsFile = /(^|\/)(requirements[\w.-]*\.txt|constraints\.txt|\.npmrc|\.yarnrc(\.yml)?|pip\.conf|\.pypirc|pyproject\.toml|Pipfile)$/.test(f.path);
  const lines = text.split(/\r?\n/);

  // Hidden characters: reported once per file with the count, as their own findings.
  const bom = text.startsWith("\ufeff") ? 1 : 0;
  const tagHits = text.match(TAGS)?.length ?? 0;
  const hiddenHits = (text.match(HIDDEN)?.length ?? 0) - bom;
  if (tagHits || hiddenHits > 0) {
    const idx = lines.findIndex((l, i) => (i === 0 ? l.replace(/^\ufeff/, "") : l).match(TAGS) || (i === 0 ? l.replace(/^\ufeff/, "") : l).match(HIDDEN));
    const where = idx >= 0 ? idx + 1 : null;
    const ex = idx >= 0 ? excerptOf(lines[idx]) : "";
    if (tagHits) add("injection.unicode_tags", "critical", f.path, where, ex, `${tagHits} invisible Unicode tag characters (ASCII smuggling: text the model reads and the user cannot see).`);
    if (hiddenHits > 0) add("injection.hidden_unicode", "high", f.path, where, ex, `${hiddenHits} zero-width or bidirectional control characters that hide or reorder text.`);
  }

  let fence = false;
  let comment = false;
  let longLine = 0;
  const netLines: number[] = [];
  let sensitiveRead = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (isMd && /^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const code = isCodeFile || fence || isPkgJson || isDepsFile;
    if (line.length > 1000 && MINIFIABLE.test(f.path) && !longLine) longLine = n;

    // Instructions hidden in an HTML comment in Markdown.
    if (isMd && !fence) {
      const opens = line.includes("<!--");
      if (opens || comment) {
        const inner = line.slice(opens ? line.indexOf("<!--") + 4 : 0);
        if (/\b(ignore|instructions?|assistant|agent|model|prompt|execute|run|send|upload|curl|secret|token|key)\b/i.test(inner) && inner.trim()) add("injection.html_comment", "medium", f.path, n, excerptOf(line), "Text in an HTML comment (hidden when rendered) that addresses the agent.");
        comment = !line.slice(opens ? line.indexOf("<!--") : 0).includes("-->");
      }
    }

    for (let s = 0; s < Math.max(1, line.length); s += CHUNK - 200) {
      const part = line.length > CHUNK ? line.slice(s, s + CHUNK) : line;
      for (const r of LINE_RULES) {
        if (r.code && !code) continue;
        if (r.id === "deps.install_hook" && !isPkgJson) continue;
        const m = r.re.exec(part);
        if (!m) continue;
        add(r.id, r.severity, f.path, n, excerptOf(part, m.index), r.message);
        if (r.id === "exfil.secret_files" || r.id === "exfil.keychain" || r.id === "exfil.browser_data" || r.id === "exfil.env_dump") sensitiveRead = true;
      }
      if (line.length <= CHUNK) break;
    }

    // Package indexes outside the defaults.
    if (code || isDepsFile) {
      const im = INDEX_RE.exec(line);
      if (im && (im[3] ? isDepsFile : im[4] || im[5] || isDepsFile || /\b(pip3?|uv|pipx|npm|pnpm|yarn|bun|poetry)\b/.test(line))) {
        const target = im[1] ?? im[2] ?? im[3] ?? im[4] ?? "";
        const host = target.replace(/^[a-z+]+:\/\//i, "").split(/[\/:]/)[0];
        if (im[5] || !hostAllowed(host, DEFAULT_INDEXES)) add("deps.untrusted_index", "high", f.path, n, excerptOf(line), "Installs packages from an index or registry outside the default ones.");
      }
    }

    // Network calls: to hosts outside the allowlist, and secrets placed into one.
    if (NET_CALL.test(line)) {
      const hosts = hostsOn(line);
      const outside = hosts.filter((h) => !hostAllowed(h, allowed));
      const secret = SECRET_REF.test(line) || SECRET_FILES.test(line);
      if (secret && (outside.length || !hosts.length) && code) {
        add("exfil.env_to_network", "critical", f.path, n, excerptOf(line), "Sends environment values or secrets in a network call to a host outside the allowlist.");
        netLines.push(n);
      } else if (outside.length) {
        add("exfil.network", "medium", f.path, n, excerptOf(line), `Network call to a host outside the allowlist (${outside.map((h) => (h === "$dynamic" ? "a host built at run time" : h)).slice(0, 3).join(", ")}).`);
        netLines.push(n);
      } else if (!hosts.length && code) {
        add("exfil.network_dynamic", "low", f.path, n, excerptOf(line), "Network call to an address built at run time.");
        netLines.push(n);
      }
    }
  }
  if (longLine) add("obfuscation.minified", "medium", f.path, longLine, excerptOf(lines[longLine - 1]), "Minified code (lines over 1,000 characters) that cannot be reviewed.");
  if (sensitiveRead && netLines.length) add("exfil.chain", "critical", f.path, netLines[0], excerptOf(lines[netLines[0] - 1]), "Reads secrets and makes a network call in the same file.");
}

/** Trust level code used on chain (SkillRegistry): 1 trusted, 2 caution, 3 dangerous. */
export const levelCode = (level: Level) => LEVELS.indexOf(level) + 1;
