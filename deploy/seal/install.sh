#!/bin/sh
# Anyroute SEAL host installer.
#
#   curl -fsSL https://get.anyroute.xyz/seal | sh -s -- [options]   (planned address, not live yet)
#   sh deploy/seal/install.sh [options]                              (from a checkout of this repository)
#
# It finds the OpenAI-compatible model server already running on this host (vLLM, SGLang, llama.cpp server or
# Ollama), writes seal.yaml (checked against seal.schema.json), sidecar.yaml, a router API key (mode 0600, never
# printed) and docker-compose.seal.yaml, which puts the Anyroute sidecar in front of the engine. It starts nothing
# unless you pass --apply. With --apply it runs `docker compose up -d`, waits for the sidecar, reads its attestation
# endpoint and prints how to verify the endpoint. Running it again with the same options changes nothing.
#
# POSIX sh. Needs curl or wget to find the engine, and sha256sum, shasum or openssl. --apply needs Docker Compose.

set -eu

SEAL_INSTALLER_VERSION=0.1.0
DEFAULT_ROUTER=https://api-production-70da.up.railway.app

# Patterns shared with seal.schema.json (test/seal-install.test.ts checks they are identical).
RE_HOST_ID='^0x[0-9a-f]{64}$'
RE_ENGINE_URL='^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$'
RE_SERVED_NAME='^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
RE_HF_REPO='^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'
RE_SHA256='^sha256:[0-9a-f]{64}$'
RE_QUANT='^[a-z0-9][a-z0-9_.-]{1,31}$'
RE_CREATOR='^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'
RE_POLICY='^[a-z0-9][a-z0-9._-]{0,63}$'
RE_KMS='^[a-z0-9][a-z0-9-]{0,63}$'
RE_REGION='^[a-z0-9][a-z0-9-]{1,31}$'
# Installer-only formats.
RE_PRICE='^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$'
RE_BPS='^(0|[1-9][0-9]{0,4})$'
RE_PORT='^[1-9][0-9]{0,4}$'
RE_IMAGE='^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$'
RE_ABS_PATH='^/[A-Za-z0-9._/-]*$'
RE_HOST='^[A-Za-z0-9._-]+$'
RE_ROUTER='^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$'

usage() {
  cat <<'USAGE'
Anyroute SEAL host installer

usage: install.sh [options]

What is served:
  --model <name>            model id the engine serves (default: the first one its /v1/models lists)
  --hf-repo <owner/name>    Hugging Face repository of the weights                                  (required)
  --weights-sha256 <digest> Anyroute model digest, sha256:<64 hex>                                  (required)
                            (bun sidecar/src/main.ts digest <weights dir>)
  --weights-dir <abs path>  mount the weights read-only so the sidecar measures them at boot
  --tokenizer-sha256 <d>    sha256:<64 hex> of tokenizer.json
  --quant <format>          bf16 (default), fp8, awq, q4_k_m, ...
  --creator-handle <h>      the model creator, for royalties     --royalty-bps <0-10000>

How it is sold:
  --lanes <list>            comma-separated: public, attested, unlinkable
                            (default: public,attested on Intel TDX, public elsewhere)
  --price-in <usdg>         USDG per million input tokens                                           (required)
  --price-out <usdg>        USDG per million output tokens                                          (required)
  --region <code>           datacenter region, e.g. eu-west                                         (required)
  --policy <id>             measured policy id (default default-v1)   --kms <id> (default anyroute-main)
  --host-id <0x + 64 hex>   HostBond id (default: generated once, then kept)

The machine:
  --engine <kind>           vllm | sglang | llamacpp | ollama (default: detected)
  --engine-url <url>        skip detection and use this engine, e.g. http://127.0.0.1:8000
  --probe-host <host>       where to look for an engine (default 127.0.0.1)
  --probe-ports "<ports>"   ports to try (default "8000 30000 8080 11434")
  --tee <kind>              tdx | sev-snp | none (default: detected)
  --cc-mode <on|off>        NVIDIA confidential-computing claim (default: detected with nvidia-smi)
  --multi-gpu <kind>        single (default) | nvle | ppcie
  --attestation <kind>      dstack | tdx | dev (default: dstack if its socket exists, tdx on TDX)
                            dev is simulated evidence for local rehearsal only
  --sidecar-image <ref>     the sidecar image, name@sha256:<64 hex>                        (required with --apply)
  --port <n>                where the sidecar listens (default 8443)

Running it:
  --dir <dir>               where to write the files (default ./anyroute-seal)
  --apply                   also run docker compose up -d and read the attestation endpoint
  --sidecar-url <url>       where --apply reaches the sidecar (default https://127.0.0.1:<port>)
  --router <url>            router for the registry link (default: the Anyroute router)
  --non-interactive         never ask; fail on anything missing (implied when there is no terminal)
  -h, --help                this text          --version     the installer version

Nothing is sent anywhere except the local engine probe and, with --apply, the local sidecar. The router API key is
written to <dir>/router-api-key (mode 0600) and never printed: give it to the router's operator privately.
USAGE
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# matches <ERE> <value>: one line, whole-value match.
matches() {
  case $2 in *'
'*) return 1 ;; esac
  printf '%s\n' "$2" | grep -Eq -- "$1"
}
need() { # <flag> <value> <ERE> <what>
  matches "$3" "$2" || die "$1 \"$2\" is not $4"
}

# ---- options ------------------------------------------------------------------------------------------------------
DIR=./anyroute-seal
MODEL='' HF_REPO='' WEIGHTS_SHA256='' WEIGHTS_DIR='' TOKENIZER_SHA256='' QUANT=bf16 CREATOR='' ROYALTY_BPS=''
LANES='' PRICE_IN='' PRICE_OUT='' REGION='' POLICY=default-v1 KMS=anyroute-main HOST_ID=''
ENGINE='' ENGINE_URL='' PROBE_HOST=127.0.0.1 PROBE_PORTS='8000 30000 8080 11434'
TEE='' CC_MODE='' MULTI_GPU=single ATTESTATION='' SIDECAR_IMAGE='' PORT=8443
APPLY=0 SIDECAR_URL='' ROUTER=$DEFAULT_ROUTER NON_INTERACTIVE=0

while [ $# -gt 0 ]; do
  opt=$1
  case $opt in
    -h | --help) usage; exit 0 ;;
    --version) say "$SEAL_INSTALLER_VERSION"; exit 0 ;;
    --apply) APPLY=1; shift; continue ;;
    --non-interactive | --yes) NON_INTERACTIVE=1; shift; continue ;;
    --*=*) val=${opt#*=}; opt=${opt%%=*}; shift ;;
    --*)
      [ $# -ge 2 ] || die "$opt needs a value"
      val=$2; shift 2 ;;
    *) die "unexpected argument \"$opt\" (see --help)" ;;
  esac
  case $opt in
    --dir) DIR=$val ;;
    --model) MODEL=$val ;;
    --hf-repo) HF_REPO=$val ;;
    --weights-sha256) WEIGHTS_SHA256=$val ;;
    --weights-dir) WEIGHTS_DIR=$val ;;
    --tokenizer-sha256) TOKENIZER_SHA256=$val ;;
    --quant) QUANT=$val ;;
    --creator-handle) CREATOR=$val ;;
    --royalty-bps) ROYALTY_BPS=$val ;;
    --lanes) LANES=$val ;;
    --price-in) PRICE_IN=$val ;;
    --price-out) PRICE_OUT=$val ;;
    --region) REGION=$val ;;
    --policy) POLICY=$val ;;
    --kms) KMS=$val ;;
    --host-id) HOST_ID=$val ;;
    --engine) ENGINE=$val ;;
    --engine-url) ENGINE_URL=$val ;;
    --probe-host) PROBE_HOST=$val ;;
    --probe-ports) PROBE_PORTS=$val ;;
    --tee) TEE=$val ;;
    --cc-mode) CC_MODE=$val ;;
    --multi-gpu) MULTI_GPU=$val ;;
    --attestation) ATTESTATION=$val ;;
    --sidecar-image) SIDECAR_IMAGE=$val ;;
    --port) PORT=$val ;;
    --sidecar-url) SIDECAR_URL=$val ;;
    --router) ROUTER=$val ;;
    *) die "unknown option $opt (see --help)" ;;
  esac
done

# Ask only when a person is at a terminal. Under `curl ... | sh` stdin is the script, so questions go to /dev/tty.
INTERACTIVE=0
if [ "$NON_INTERACTIVE" = 0 ] && (: </dev/tty) 2>/dev/null && [ -t 1 ]; then INTERACTIVE=1; fi

ask() { # <variable> <question> [default]
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s%s: ' "$2" "${3:+ [$3]}" >/dev/tty
    IFS= read -r answer </dev/tty || answer=''
    [ -n "$answer" ] || answer=${3:-}
    eval "$1=\$answer"
  fi
}

# ---- tools --------------------------------------------------------------------------------------------------------
http_get() { # <url>: body on stdout
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time "${SEAL_PROBE_TIMEOUT:-3}" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "${SEAL_PROBE_TIMEOUT:-3}" -O - "$1"
  else
    return 127
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | cut -d' ' -f1
  else
    die "need sha256sum, shasum or openssl"
  fi
}

random_hex32() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

# Replace <dest> with <tmp> only when the content differs, so a re-run leaves files (and their mtimes) alone.
install_file() { # <tmp> <dest> <mode>
  chmod "$3" "$1"
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    rm -f "$1"
    say "  unchanged  $2"
  else
    mv -f "$1" "$2"
    say "  wrote      $2"
  fi
}

# ---- find the engine ----------------------------------------------------------------------------------------------
classify_engine() { # <base url> <compact /v1/models body> <port>
  case $2 in
    *'"owned_by":"vllm"'*) say vllm; return 0 ;;
    *'"owned_by":"sglang"'*) say sglang; return 0 ;;
    *'"owned_by":"llamacpp"'*) say llamacpp; return 0 ;;
  esac
  if http_get "$1/api/version" >/dev/null 2>&1; then say ollama; return 0; fi
  if http_get "$1/get_model_info" >/dev/null 2>&1; then say sglang; return 0; fi
  if http_get "$1/props" >/dev/null 2>&1; then say llamacpp; return 0; fi
  if http_get "$1/version" >/dev/null 2>&1; then say vllm; return 0; fi
  case $3 in
    8000) say vllm ;;
    30000) say sglang ;;
    8080) say llamacpp ;;
    11434) say ollama ;;
    *) say unknown ;;
  esac
}

first_model_id() { # compact /v1/models body -> first "id"
  printf '%s' "$1" | tr ',{' '\n' | sed -n 's/^"id":"\([^"]*\)".*$/\1/p' | head -n 1
}

DETECTED_MODEL=''
probe_engine() { # <base url> <port>: sets ENGINE_URL, DETECTED_KIND, DETECTED_MODEL on success
  body=$(http_get "$1/v1/models" 2>/dev/null) || return 1
  compact=$(printf '%s' "$body" | tr -d ' \t\r\n')
  case $compact in *'"data":'*) ;; *) return 1 ;; esac
  DETECTED_KIND=$(classify_engine "$1" "$compact" "$2")
  DETECTED_MODEL=$(first_model_id "$compact")
  ENGINE_URL=$1
  return 0
}

say "Anyroute SEAL installer $SEAL_INSTALLER_VERSION"
need --probe-host "$PROBE_HOST" "$RE_HOST" "a host name or address"
ROUTER=${ROUTER%/}
need --router "$ROUTER" "$RE_ROUTER" "an http(s) URL without a path"
DETECTED_KIND=''
if [ -n "$ENGINE_URL" ]; then
  ENGINE_URL=${ENGINE_URL%/}
  ENGINE_URL=${ENGINE_URL%/v1}
  need --engine-url "$ENGINE_URL" "$RE_ENGINE_URL" "an http(s) URL without a path"
  port=${ENGINE_URL##*:}
  case $port in *[!0-9]*) port='' ;; esac
  if probe_engine "$ENGINE_URL" "$port"; then
    say "engine:    $DETECTED_KIND at $ENGINE_URL"
  else
    warn "no OpenAI-compatible /v1/models answered at $ENGINE_URL; writing the files anyway"
  fi
else
  for port in $PROBE_PORTS; do
    need --probe-ports "$port" "$RE_PORT" "a port"
    if probe_engine "http://$PROBE_HOST:$port" "$port"; then
      say "engine:    $DETECTED_KIND at $ENGINE_URL"
      break
    fi
  done
  if [ -z "$ENGINE_URL" ]; then
    ask ENGINE_URL "No engine found on $PROBE_HOST ports $PROBE_PORTS. Engine URL"
    [ -n "$ENGINE_URL" ] || die "no OpenAI-compatible engine answered /v1/models on $PROBE_HOST ports $PROBE_PORTS; start vLLM, SGLang, llama.cpp server or Ollama first, or pass --engine-url"
    need --engine-url "$ENGINE_URL" "$RE_ENGINE_URL" "an http(s) URL without a path"
  fi
fi
[ -n "$ENGINE" ] || ENGINE=$DETECTED_KIND
if [ -z "$ENGINE" ] || [ "$ENGINE" = unknown ]; then
  ask ENGINE "Engine kind (vllm, sglang, llamacpp, ollama)" vllm
  [ -n "$ENGINE" ] && [ "$ENGINE" != unknown ] || die "could not tell which engine this is; pass --engine vllm|sglang|llamacpp|ollama"
fi
case $ENGINE in vllm | sglang | llamacpp | ollama) ;; *) die "--engine must be vllm, sglang, llamacpp or ollama" ;; esac
[ -n "$MODEL" ] || MODEL=$DETECTED_MODEL
if [ -n "$MODEL" ]; then need --model "$MODEL" "$RE_SERVED_NAME" "a model id"; fi

# ---- detect the machine -------------------------------------------------------------------------------------------
if [ -z "$TEE" ]; then
  if [ -S /var/run/dstack.sock ] || [ -e /sys/kernel/config/tsm/report ] || [ -e /dev/tdx_guest ] || grep -qs tdx_guest /proc/cpuinfo; then
    TEE=tdx
  elif [ -e /dev/sev-guest ] || grep -qs sev_snp /proc/cpuinfo; then
    TEE=sev-snp
  else
    TEE=none
  fi
fi
case $TEE in tdx | sev-snp | none) ;; *) die "--tee must be tdx, sev-snp or none" ;; esac
if [ -z "$CC_MODE" ]; then
  CC_MODE=off
  if [ "$TEE" = tdx ] && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi conf-compute -f 2>/dev/null | grep -qi 'CC status: *ON'; then CC_MODE=on; fi
fi
case $CC_MODE in on | off) ;; *) die "--cc-mode must be on or off" ;; esac
case $MULTI_GPU in single | nvle | ppcie) ;; *) die "--multi-gpu must be single, nvle or ppcie" ;; esac
if [ -z "$ATTESTATION" ]; then
  if [ -S /var/run/dstack.sock ]; then ATTESTATION=dstack
  elif [ "$TEE" = tdx ]; then ATTESTATION=tdx
  else ATTESTATION=none
  fi
fi
case $ATTESTATION in dstack | tdx | dev | none) ;; *) die "--attestation must be dstack, tdx or dev" ;; esac
say "machine:   tee=$TEE gpu_cc=$CC_MODE attestation=$ATTESTATION"

# ---- what is served and how it is sold ----------------------------------------------------------------------------
[ -n "$HF_REPO" ] || ask HF_REPO "Hugging Face repository (owner/name)"
[ -n "$HF_REPO" ] || die "--hf-repo is required"
need --hf-repo "$HF_REPO" "$RE_HF_REPO" "owner/name"
[ -n "$WEIGHTS_SHA256" ] || ask WEIGHTS_SHA256 "Model digest (sha256:<64 hex>, from: bun sidecar/src/main.ts digest <dir>)"
[ -n "$WEIGHTS_SHA256" ] || die "--weights-sha256 is required (bun sidecar/src/main.ts digest <weights dir>)"
case $WEIGHTS_SHA256 in sha256:*) ;; *) WEIGHTS_SHA256=sha256:$WEIGHTS_SHA256 ;; esac
need --weights-sha256 "$WEIGHTS_SHA256" "$RE_SHA256" "sha256:<64 lowercase hex>"
if [ -n "$TOKENIZER_SHA256" ]; then
  case $TOKENIZER_SHA256 in sha256:*) ;; *) TOKENIZER_SHA256=sha256:$TOKENIZER_SHA256 ;; esac
  need --tokenizer-sha256 "$TOKENIZER_SHA256" "$RE_SHA256" "sha256:<64 lowercase hex>"
fi
if [ -n "$WEIGHTS_DIR" ]; then
  need --weights-dir "$WEIGHTS_DIR" "$RE_ABS_PATH" "an absolute path"
  [ -d "$WEIGHTS_DIR" ] || warn "--weights-dir $WEIGHTS_DIR is not a directory here (fine if the files move to this host later)"
fi
need --quant "$QUANT" "$RE_QUANT" "a weight format like bf16"
if [ -n "$CREATOR" ]; then need --creator-handle "$CREATOR" "$RE_CREATOR" "a handle"; fi
if [ -n "$ROYALTY_BPS" ]; then
  need --royalty-bps "$ROYALTY_BPS" "$RE_BPS" "a whole number of basis points"
  [ "$ROYALTY_BPS" -le 10000 ] || die "--royalty-bps must be at most 10000"
fi

if [ -z "$LANES" ]; then
  if [ "$TEE" = tdx ]; then LANES=public,attested; else LANES=public; fi
fi
lanes_yaml='' seen=','
old_ifs=$IFS
IFS=,
for lane in $LANES; do
  case $lane in public | attested | unlinkable) ;; *) IFS=$old_ifs; die "--lanes: \"$lane\" is not public, attested or unlinkable" ;; esac
  case $seen in *",$lane,"*) IFS=$old_ifs; die "--lanes lists $lane twice" ;; esac
  seen="$seen$lane,"
  lanes_yaml="${lanes_yaml:+$lanes_yaml, }$lane"
done
IFS=$old_ifs
[ -n "$lanes_yaml" ] || die "--lanes is empty"

for pair in "PRICE_IN:--price-in:USDG per million input tokens" "PRICE_OUT:--price-out:USDG per million output tokens"; do
  var=${pair%%:*} rest=${pair#*:}
  flag=${rest%%:*} what=${rest#*:}
  eval "val=\$$var"
  [ -n "$val" ] || ask "$var" "Price, $what"
  eval "val=\$$var"
  [ -n "$val" ] || die "$flag is required ($what)"
  need "$flag" "$val" "$RE_PRICE" "a decimal number like 0.20"
  awk -v p="$val" 'BEGIN { exit !(p + 0 <= 1000) }' || die "$flag must be at most 1000"
done
[ -n "$REGION" ] || ask REGION "Region (e.g. eu-west)"
[ -n "$REGION" ] || die "--region is required"
need --region "$REGION" "$RE_REGION" "a region code like eu-west"
need --policy "$POLICY" "$RE_POLICY" "a policy id"
need --kms "$KMS" "$RE_KMS" "a KMS cluster id"
need --port "$PORT" "$RE_PORT" "a port"
[ "$PORT" -le 65535 ] || die "--port must be at most 65535"

# The same rules as seal.schema.json's allOf, with the same reasons.
case ",$LANES," in *,attested,* | *,unlinkable,*)
  [ "$TEE" = tdx ] || die "attested and unlinkable lanes need an Intel TDX host (tee is $TEE); use --lanes public" ;;
esac
if [ "$CC_MODE" = on ] && [ "$TEE" != tdx ]; then
  die "a confidential-GPU claim needs Intel TDX: SEV-SNP has no runtime measurement register to bind GPU evidence into (use --cc-mode off)"
fi
if [ "$TEE" = sev-snp ]; then
  warn "SEV-SNP: CPU claims only, never confidential-GPU claims, and the sidecar has no SEV-SNP evidence provider yet"
fi
if [ "$ATTESTATION" = dev ]; then
  warn "attestation dev: SIMULATED evidence for local rehearsal. It proves nothing and routers refuse it on attested lanes."
fi
if [ "$MULTI_GPU" = ppcie ]; then warn "multi-gpu ppcie: NVLink traffic between GPUs is not encrypted; disclose it"; fi

# ---- write the files ----------------------------------------------------------------------------------------------
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
umask 077

# The HostBond id is generated once and kept, so re-running never changes the identity of the host.
if [ -z "$HOST_ID" ] && [ -f "$DIR/seal.yaml" ]; then
  HOST_ID=$(sed -n 's/^host_id: *"\{0,1\}\(0x[0-9a-f]\{64\}\)"\{0,1\} *$/\1/p' "$DIR/seal.yaml" | head -n 1)
fi
[ -n "$HOST_ID" ] || HOST_ID=0x$(random_hex32)
need --host-id "$HOST_ID" "$RE_HOST_ID" "0x and 64 lowercase hex"

# The router API key: 32 random bytes, hex, 0600, never overwritten and never printed. Only its SHA-256 is written
# anywhere else.
if [ ! -s "$DIR/router-api-key" ]; then
  random_hex32 >"$DIR/router-api-key.tmp.$$"
  chmod 600 "$DIR/router-api-key.tmp.$$"
  mv -f "$DIR/router-api-key.tmp.$$" "$DIR/router-api-key"
  say "  wrote      $DIR/router-api-key (0600, not shown)"
else
  chmod 600 "$DIR/router-api-key"
  say "  kept       $DIR/router-api-key"
fi
KEY_SHA256=$(sha256_stdin <"$DIR/router-api-key")

tmp="$DIR/seal.yaml.tmp.$$"
{
  say "# seal.yaml, written by the Anyroute SEAL installer $SEAL_INSTALLER_VERSION. Schema: seal.schema.json (version 1)."
  say "# Re-run the installer to change it; it keeps host_id and the router key."
  say "version: 1"
  say "host_id: \"$HOST_ID\""
  say "engine: $ENGINE"
  say "engine_url: \"$ENGINE_URL\""
  say "model:"
  if [ -n "$MODEL" ]; then say "  served_name: \"$MODEL\""; fi
  say "  hf_repo: \"$HF_REPO\""
  say "  weights_sha256: \"$WEIGHTS_SHA256\""
  if [ -n "$TOKENIZER_SHA256" ]; then say "  tokenizer_sha256: \"$TOKENIZER_SHA256\""; fi
  say "  quant: \"$QUANT\""
  if [ -n "$CREATOR" ]; then say "  creator_handle: \"$CREATOR\""; fi
  if [ -n "$ROYALTY_BPS" ]; then say "  royalty_bps: $ROYALTY_BPS"; fi
  say "lanes: [$lanes_yaml]"
  say "pricing: { input_per_m_usdg: $PRICE_IN, output_per_m_usdg: $PRICE_OUT }"
  say "policy: \"$POLICY\""
  say "tee: $TEE"
  say "gpu: { cc_mode: \"$CC_MODE\", multi_gpu: $MULTI_GPU }"
  say "kms: \"$KMS\""
  say "region: \"$REGION\""
} >"$tmp"

# Full schema check when this runs from a checkout with Bun; the values above were already checked with the same
# patterns and rules. validate.ts exits 3 when the file is invalid; anything else means it could not run.
if [ -n "${SEAL_VALIDATOR:-}" ]; then
  validator=$SEAL_VALIDATOR
else
  case $0 in */install.sh) validator=$(cd "$(dirname "$0")" && pwd)/validate.ts ;; *) validator='' ;; esac
fi
if [ -n "$validator" ] && [ -f "$validator" ] && command -v bun >/dev/null 2>&1; then
  set +e
  bun "$validator" "$tmp" >/dev/null
  rc=$?
  set -e
  if [ "$rc" = 3 ]; then
    rm -f "$tmp"
    die "seal.yaml failed the schema check (see above)"
  elif [ "$rc" = 0 ]; then
    say "  checked    seal.yaml against seal.schema.json"
  else
    warn "the schema validator could not run (exit $rc); the installer's own checks passed"
  fi
fi
install_file "$tmp" "$DIR/seal.yaml" 644

tmp="$DIR/sidecar.yaml.tmp.$$"
{
  say "# sidecar.yaml, written by the Anyroute SEAL installer from seal.yaml. Every setting: sidecar/sidecar.example.yaml."
  say "server:"
  say "  host: 0.0.0.0"
  say "  port: $PORT"
  say "  tls: self_signed"
  say "upstream:"
  say "  base_url: \"$ENGINE_URL\""
  say "model:"
  if [ -n "$WEIGHTS_DIR" ]; then say "  path: /models/model"; else say "  digest: \"$WEIGHTS_SHA256\""; fi
  if [ -n "$MODEL" ]; then say "  served_name: \"$MODEL\""; fi
  say "allowlist:"
  say "  model_digests: [\"$WEIGHTS_SHA256\"]"
  if [ "$ATTESTATION" = tdx ] || [ "$ATTESTATION" = dev ]; then
    say "compose:"
    say "  file: /etc/seal/docker-compose.seal.yaml"
  fi
  say "attestation:"
  if [ "$ATTESTATION" = none ]; then say "  provider: tdx # no TDX found: this sidecar cannot attest here"; else say "  provider: $ATTESTATION"; fi
  say "auth:"
  say "  keys:"
  say "    - id: router"
  say "      sha256: \"$KEY_SHA256\""
} >"$tmp"
install_file "$tmp" "$DIR/sidecar.yaml" 644

if [ -n "$SIDECAR_IMAGE" ]; then
  need --sidecar-image "$SIDECAR_IMAGE" "$RE_IMAGE" "an image pinned by digest (name@sha256:<64 hex>)"
  IMAGE_REF=$SIDECAR_IMAGE
  IMAGE_DIGEST=${SIDECAR_IMAGE##*@}
else
  # Left for Compose to fill in: without --sidecar-image the file refuses to start until SIDECAR_IMAGE is set.
  # shellcheck disable=SC2016
  IMAGE_REF='${SIDECAR_IMAGE:?pass --sidecar-image name@sha256:... to the installer}'
  # shellcheck disable=SC2016
  IMAGE_DIGEST='${SIDECAR_IMAGE_DIGEST:?pass --sidecar-image to the installer}'
fi
SEAL_YAML_SHA256=$(sha256_stdin <"$DIR/seal.yaml")
SIDECAR_YAML_SHA256=$(sha256_stdin <"$DIR/sidecar.yaml")
case $ATTESTATION in none) RUN_AS=bun ;; tdx) RUN_AS=0:0 ;; *) RUN_AS=bun ;; esac
if [ -n "$WEIGHTS_DIR" ]; then KEEP_WEIGHTS=1; else KEEP_WEIGHTS=0; fi

compose_template() {
  # BEGIN docker-compose.seal.yaml (identical to deploy/seal/docker-compose.seal.yaml; a test compares them)
  cat <<'SEAL_COMPOSE_EOF'
# docker-compose.seal.yaml: the Anyroute sidecar in front of a model server that is already running on this host.
#
# Template. install.sh renders it: it replaces each __NAME__ token, keeps the lines tagged with the attestation
# provider it chose (# seal:dstack, # seal:tdx or # seal:dev) and # seal:weights when you pass --weights-dir, drops
# the other tagged lines and removes the tags.
# The engine (vLLM, SGLang, llama.cpp server or Ollama) stays yours; this file only adds the sidecar.
#
# The file is part of what gets attested: on dstack the platform measures it, on a bare TDX host the sidecar hashes
# it (compose.file in sidecar.yaml). The labels commit to the exact seal.yaml and sidecar.yaml it runs with.

name: anyroute-seal

services:
  sidecar:
    # Pinned by digest. SIDECAR_IMAGE_DIGEST repeats it: a process cannot read its own image digest, so the operator
    # declares it and the sidecar binds it into the attestation.
    image: __SIDECAR_IMAGE__
    # Host networking: the sidecar reaches the engine on the host's loopback (engine_url in seal.yaml) and the engine
    # port is never published. The sidecar listens on __SIDECAR_PORT__.
    network_mode: host
    user: "__RUN_AS__"
    environment:
      SIDECAR_CONFIG: /etc/seal/sidecar.yaml
      SIDECAR_IMAGE_DIGEST: "__SIDECAR_IMAGE_DIGEST__"
      SIDECAR_PORT: "__SIDECAR_PORT__"
      SIDECAR_DEV_ATTESTATION: "true" # seal:dev
    volumes:
      - ./seal.yaml:/etc/seal/seal.yaml:ro
      - ./sidecar.yaml:/etc/seal/sidecar.yaml:ro
      # With --weights-dir the sidecar hashes the weights at boot and refuses to start on a mismatch. Without it the
      # digest in seal.yaml is declared, not measured, and /attest says so (digest_source: declared).
      - __WEIGHTS_DIR__:/models/model:ro # seal:weights
      - ./docker-compose.seal.yaml:/etc/seal/docker-compose.seal.yaml:ro # seal:tdx
      - ./docker-compose.seal.yaml:/etc/seal/docker-compose.seal.yaml:ro # seal:dev
      - /var/run/dstack.sock:/var/run/dstack.sock # seal:dstack
      - /sys/kernel/config:/sys/kernel/config # seal:tdx
    labels:
      xyz.anyroute.seal.version: "1"
      xyz.anyroute.seal.host-id: "__HOST_ID__"
      xyz.anyroute.seal.seal-yaml-sha256: "__SEAL_YAML_SHA256__"
      xyz.anyroute.seal.sidecar-yaml-sha256: "__SIDECAR_YAML_SHA256__"
    restart: unless-stopped
    security_opt: ["no-new-privileges:true"]
SEAL_COMPOSE_EOF
  # END docker-compose.seal.yaml
}

tmp="$DIR/docker-compose.seal.yaml.tmp.$$"
compose_template | sed \
  -e "s|__SIDECAR_IMAGE_DIGEST__|$IMAGE_DIGEST|g" \
  -e "s|__SIDECAR_IMAGE__|$IMAGE_REF|g" \
  -e "s|__SIDECAR_PORT__|$PORT|g" \
  -e "s|__RUN_AS__|$RUN_AS|g" \
  -e "s|__WEIGHTS_DIR__|$WEIGHTS_DIR|g" \
  -e "s|__HOST_ID__|$HOST_ID|g" \
  -e "s|__SEAL_YAML_SHA256__|$SEAL_YAML_SHA256|g" \
  -e "s|__SIDECAR_YAML_SHA256__|$SIDECAR_YAML_SHA256|g" |
  awk -v keep="$ATTESTATION" -v weights="$KEEP_WEIGHTS" '
    / # seal:[a-z]+$/ {
      tag = $NF; sub(/^seal:/, "", tag)
      if (tag == keep || (tag == "weights" && weights == "1")) { sub(/ # seal:[a-z]+$/, ""); print }
      next
    }
    { print }' >"$tmp"
install_file "$tmp" "$DIR/docker-compose.seal.yaml" 644

tmp="$DIR/.gitignore.tmp.$$"
printf '%s\n' '# The router key never goes into a repository.' router-api-key '*.tmp.*' attest.json >"$tmp"
install_file "$tmp" "$DIR/.gitignore" 644

# ---- apply --------------------------------------------------------------------------------------------------------
[ -n "$SIDECAR_URL" ] || SIDECAR_URL=https://127.0.0.1:$PORT
SIDECAR_URL=${SIDECAR_URL%/}
if [ "$APPLY" = 1 ]; then
  [ "$ATTESTATION" != none ] || die "--apply: this host has no Intel TDX (tee=$TEE), so the sidecar cannot attest here. The files are written for review; see deploy/seal/README.md"
  [ -n "$SIDECAR_IMAGE" ] || die "--apply needs --sidecar-image name@sha256:<64 hex>"
  docker_cmd=${SEAL_DOCKER:-docker}
  command -v "$docker_cmd" >/dev/null 2>&1 || die "--apply needs Docker ($docker_cmd not found)"
  say "starting:  $docker_cmd compose up -d"
  "$docker_cmd" compose --project-directory "$DIR" -f "$DIR/docker-compose.seal.yaml" up -d
  # -k: the sidecar's certificate is self-signed and bound to its quote. This only fetches the evidence;
  # `seal verify` then checks the certificate against the quote.
  waited=0 limit=${SEAL_WAIT_SECONDS:-900}
  until curl -fsSk --max-time 5 "$SIDECAR_URL/healthz" >/dev/null 2>&1; do
    [ "$waited" -lt "$limit" ] || die "the sidecar did not become healthy at $SIDECAR_URL/healthz within ${limit}s (docker compose logs sidecar)"
    sleep 5
    waited=$((waited + 5))
  done
  curl -fsSk --max-time 30 "$SIDECAR_URL/attest" >"$DIR/attest.json.tmp.$$" || die "could not read $SIDECAR_URL/attest"
  mv -f "$DIR/attest.json.tmp.$$" "$DIR/attest.json"
  chmod 644 "$DIR/attest.json"
  ref=$(tr -d ' \n' <"$DIR/attest.json" | sed -n 's/.*"attestation_ref":"\([0-9a-f]\{64\}\)".*/\1/p')
  [ -n "$ref" ] || die "$SIDECAR_URL/attest did not return an attestation reference"
  say "attested:  reference $ref (saved to $DIR/attest.json)"
  if tr -d ' \n' <"$DIR/attest.json" | grep -q '"dev":true'; then
    warn "the sidecar reports SIMULATED evidence (dev). Nothing here is attested."
  fi
fi

say ""
say "Done. Files in $DIR: seal.yaml, sidecar.yaml, docker-compose.seal.yaml, router-api-key (0600, not shown)."
say "host_id:   $HOST_ID"
if [ "$APPLY" = 0 ]; then say "start:     sh install.sh <same options> --apply --sidecar-image <name@sha256:...>"; fi
say "verify:    bun scripts/seal-cli.ts verify https://<public address>:$PORT"
say "registry:  $ROUTER/registry/<provider id>/   (once the router lists this endpoint)"
say "planned:   https://verify.anyroute.xyz/$HOST_ID   (placeholder address, not live yet)"
