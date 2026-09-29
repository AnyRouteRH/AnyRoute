{{/* Names and the checks every template relies on. */}}

{{- define "seal.fullname" -}}
{{- printf "%s-seal" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "seal.labels" -}}
app.kubernetes.io/name: seal
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "seal.selector" -}}
app.kubernetes.io/name: seal
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The sidecar image, refused unless pinned by digest. */}}
{{- define "seal.sidecarImage" -}}
{{- $img := required "sidecar.image is required (name@sha256:<64 hex>)" .Values.sidecar.image -}}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" $img) -}}
{{- fail "sidecar.image must be pinned by digest (name@sha256:<64 hex>)" -}}
{{- end -}}
{{- $img -}}
{{- end -}}

{{- define "seal.engineImage" -}}
{{- $img := required "engine.image is required (name@sha256:<64 hex>)" .Values.engine.image -}}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" $img) -}}
{{- fail "engine.image must be pinned by digest (name@sha256:<64 hex>)" -}}
{{- end -}}
{{- $img -}}
{{- end -}}

{{/* Lanes other than public need Intel TDX, and so does a confidential-GPU claim (same rules as seal.schema.json). */}}
{{- define "seal.checkClaims" -}}
{{- $tee := .Values.seal.tee -}}
{{- range .Values.seal.lanes -}}
{{- if and (ne . "public") (ne $tee "tdx") -}}
{{- fail (printf "lane %s needs an Intel TDX host (seal.tee is %s)" . $tee) -}}
{{- end -}}
{{- end -}}
{{- if and (eq (toString .Values.seal.gpu.cc_mode) "on") (ne $tee "tdx") -}}
{{- fail "a confidential-GPU claim needs Intel TDX: SEV-SNP has no runtime measurement register to bind GPU evidence into" -}}
{{- end -}}
{{- if not (has .Values.sidecar.attestation (list "tdx" "dstack" "dev")) -}}
{{- fail "sidecar.attestation must be tdx, dstack or dev" -}}
{{- end -}}
{{- end -}}
