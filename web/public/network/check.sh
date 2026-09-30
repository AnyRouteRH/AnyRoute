#!/bin/sh
# Read-only hardware hints. No network calls, writes, privilege escalation or configuration changes.
set -eu
LC_ALL=C
export LC_ALL
# Optional filesystem prefix for isolated fixtures; normally empty (the running machine).
root=${ANYROUTE_CHECK_ROOT:-}
tdx_guest=no
snp_guest=no
tdx_host=unknown
snp_host=unknown
gpu=none-detected
driver=unknown
cc=unknown
capability=unknown

[ ! -e "$root/dev/tdx_guest" ] && [ ! -e "$root/dev/tdx-guest" ] || tdx_guest=yes
[ ! -e "$root/dev/sev-guest" ] || snp_guest=yes

enabled() {
    [ -r "$1" ] && grep -Eiq '^(Y|1|yes|on)$' "$1"
}
if enabled "$root/sys/module/kvm_intel/parameters/tdx"; then tdx_host=enabled-hint; fi
if enabled "$root/sys/module/kvm_amd/parameters/sev_snp"; then snp_host=enabled-hint; fi
if [ -r "$root/proc/cpuinfo" ]; then
    if [ "$tdx_host" = unknown ] && grep -Eiq '(^|[[:space:]])(tdx|tdx_host)([[:space:]]|$)' "$root/proc/cpuinfo"; then tdx_host=cpu-hint; fi
    if [ "$snp_host" = unknown ] && grep -Eiq '(^|[[:space:]])sev_snp([[:space:]]|$)' "$root/proc/cpuinfo"; then snp_host=cpu-hint; fi
fi
kernel_note='Kernel log unavailable; sudo may give a better answer. No root access is requested.'
if [ -z "$root" ] && command -v dmesg >/dev/null 2>&1; then
    if kernel=$(dmesg 2>/dev/null); then
        kernel_note='Readable kernel log checked for enabled host hints.'
        if [ "$tdx_host" = unknown ] && printf '%s\n' "$kernel" | grep -Eiq 'TDX.*(enabled|initialized|ready)'; then tdx_host=kernel-hint; fi
        if [ "$snp_host" = unknown ] && printf '%s\n' "$kernel" | grep -Eiq 'SEV[- ]SNP.*(enabled|initialized|ready)'; then snp_host=kernel-hint; fi
    fi
fi

if command -v nvidia-smi >/dev/null 2>&1; then
    if cards=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null) && [ -n "$cards" ]; then
        gpu=$(printf '%s\n' "$cards" | awk -F, '{gsub(/^[ \t]+|[ \t]+$/, "", $1); n[$1]++} END {for (m in n) {if (s != "") s=s " + "; s=s n[m] "x" m} print s}' | cut -c 1-140)
        driver=$(printf '%s\n' "$cards" | awk -F, 'NR==1 {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')
    fi
    # Queries only: never use any --set option. Older drivers may only support -f and -gg.
    if info=$(nvidia-smi conf-compute -q 2>/dev/null); then :
    else info=$(nvidia-smi conf-compute -f 2>/dev/null || true); fi
    states=$(printf '%s\n' "$info" | awk -F: 'tolower($1) ~ /cc state|cc status|current cc mode/ {v=tolower($2); gsub(/^[ \t]+|[ \t]+$/, "", v); print v}')
    if [ -n "$states" ]; then
        if printf '%s\n' "$states" | grep -Evq '^on$'; then
            if printf '%s\n' "$states" | grep -Evq '^off$'; then cc=mixed-or-unknown; else cc=off; fi
        else cc=on; fi
    fi
    caps=$(nvidia-smi conf-compute -gg 2>/dev/null || true)
    if printf '%s\n%s\n' "$info" "$caps" | grep -Eiq '(GPU CC Capabilities|GPU.*capability)[[:space:]]*:[[:space:]]*CC Capable'; then capability=reported; fi
fi

printf 'AnyRoute readiness: TDX guest=%s · SEV-SNP guest=%s · TDX host=%s · SEV-SNP host=%s · GPU=%s · GPU CC=%s · driver=%s\n' "$tdx_guest" "$snp_guest" "$tdx_host" "$snp_host" "$gpu" "$cc" "$driver"
printf 'GPU CC capability=%s. %s\n' "$capability" "$kernel_note"
printf '%s\n' 'This is a hint, not attestation. Real eligibility is proven by attestation when hosting opens. Unknown or absent hints do not prove unsupported hardware. Nothing is changed or sent; paste only what you choose into the waitlist.'
