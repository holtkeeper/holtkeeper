{{- define "holtkeeper.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "holtkeeper.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "holtkeeper.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "holtkeeper.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels of one component: pass (dict "ctx" $ "component" "web"). */}}
{{- define "holtkeeper.selectorLabels" -}}
app.kubernetes.io/name: {{ include "holtkeeper.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "holtkeeper.componentLabels" -}}
{{ include "holtkeeper.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "holtkeeper.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "holtkeeper.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "holtkeeper.configMapName" -}}
{{- default (printf "%s-config" (include "holtkeeper.fullname" .)) .Values.config.existingConfigMap -}}
{{- end -}}

{{- define "holtkeeper.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "holtkeeper.egressProxyImage" -}}
{{- $image := .Values.egressProxy.image -}}
{{- printf "%s:%s" $image.repository (default (default .Chart.AppVersion .Values.image.tag) $image.tag) -}}
{{- end -}}

{{- define "holtkeeper.egressCaSecret" -}}
{{- $ca := .Values.egressProxy.ca -}}
{{- if $ca.existingSecret -}}
{{- $ca.existingSecret -}}
{{- else if $ca.certManager -}}
{{- printf "%s-egress-proxy-ca" (include "holtkeeper.fullname" .) -}}
{{- else -}}
{{- fail "egressProxy needs a CA: set egressProxy.ca.existingSecret or egressProxy.ca.certManager" -}}
{{- end -}}
{{- end -}}

{{- define "holtkeeper.configContent" -}}
{{- if .Values.config.content -}}
{{- .Values.config.content -}}
{{- else -}}
{{- .Files.Get "files/holtkeeper.config.ts" -}}
{{- end -}}
{{- end -}}

{{/* Roles of the web Deployment: the scheduler runs inside it unless it has its own Deployment. */}}
{{- define "holtkeeper.webRoles" -}}
{{- if .Values.scheduler.enabled -}}web{{- else -}}web,scheduler{{- end -}}
{{- end -}}

{{- define "holtkeeper.podAnnotations" -}}
checksum/config: {{ include "holtkeeper.configContent" . | sha256sum }}
{{- with .Values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Environment shared by every container. */}}
{{- define "holtkeeper.env" -}}
- name: HOLTKEEPER_PORT
  value: {{ .Values.port | quote }}
{{- with .Values.env }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "holtkeeper.envFrom" -}}
{{- if .Values.existingSecret }}
- secretRef:
    name: {{ .Values.existingSecret }}
{{- end }}
{{- with .Values.envFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "holtkeeper.probes" -}}
startupProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 2
  failureThreshold: 60
livenessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /readyz, port: http }
  periodSeconds: 5
  timeoutSeconds: 5
  failureThreshold: 2
{{- end -}}

{{- define "holtkeeper.configVolume" -}}
- name: config
  configMap:
    name: {{ include "holtkeeper.configMapName" . }}
    items:
      - key: holtkeeper.config.ts
        path: holtkeeper.config.ts
- name: tmp
  emptyDir:
    sizeLimit: {{ .Values.tmpSizeLimit }}
{{- end -}}

{{- define "holtkeeper.configMount" -}}
- name: config
  mountPath: /app/config/holtkeeper.config.ts
  subPath: holtkeeper.config.ts
  readOnly: true
- name: tmp
  mountPath: /tmp
{{- end -}}

{{- define "holtkeeper.podSpecCommon" -}}
serviceAccountName: {{ include "holtkeeper.serviceAccountName" . }}
automountServiceAccountToken: false
enableServiceLinks: false
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end -}}

{{/* The worker container, shared by the Deployment and the KEDA ScaledJob. */}}
{{- define "holtkeeper.workerContainer" -}}
- name: worker
  image: {{ include "holtkeeper.image" .ctx }}
  imagePullPolicy: {{ .ctx.Values.image.pullPolicy }}
  args:
    - -c
    - /app/config/holtkeeper.config.ts
    - --role
    - worker
    - --drain-timeout
    - {{ .worker.drainTimeout | quote }}
    {{- with .worker.concurrency }}
    - --concurrency
    - {{ . | quote }}
    {{- end }}
    {{- if .maxJobs }}
    - --max-jobs
    - {{ .maxJobs | quote }}
    {{- end }}
    {{- range .worker.extraArgs }}
    - {{ . | quote }}
    {{- end }}
  ports:
    - name: http
      containerPort: {{ .ctx.Values.port }}
  env:
    {{- include "holtkeeper.env" .ctx | nindent 4 }}
    {{- with .ctx.Values.egressProxy }}
    {{- if .enabled }}
    - name: HOLTKEEPER_EGRESS_PROXY
      value: {{ printf "http://%s-egress-proxy:%v" (include "holtkeeper.fullname" $.ctx) .port | quote }}
    - name: HOLTKEEPER_EGRESS_CA
      value: /etc/holtkeeper/egress-ca/tls.crt
    {{- with .noProxy }}
    - name: HOLTKEEPER_EGRESS_NO_PROXY
      value: {{ join "," . | quote }}
    {{- end }}
    {{- end }}
    {{- end }}
  {{- with (include "holtkeeper.envFrom" .ctx | trim) }}
  envFrom:
    {{- . | nindent 4 }}
  {{- end }}
  {{- include "holtkeeper.probes" .ctx | nindent 2 }}
  securityContext:
    {{- toYaml .ctx.Values.containerSecurityContext | nindent 4 }}
  resources:
    {{- toYaml .worker.resources | nindent 4 }}
  volumeMounts:
    {{- include "holtkeeper.configMount" .ctx | nindent 4 }}
    - name: workspace
      mountPath: /workspace
    - name: mise
      mountPath: /mise
    {{- if .ctx.Values.egressProxy.enabled }}
    - name: egress-ca
      mountPath: /etc/holtkeeper/egress-ca
      readOnly: true
    {{- end }}
{{- end -}}

{{- define "holtkeeper.workerVolumes" -}}
{{ include "holtkeeper.configVolume" . }}
- name: workspace
  emptyDir:
    sizeLimit: {{ .Values.worker.workspace.sizeLimit }}
- name: mise
  {{- if eq .Values.worker.miseCache.type "pvc" }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-mise" (include "holtkeeper.fullname" .)) .Values.worker.miseCache.existingClaim }}
  {{- else }}
  emptyDir:
    sizeLimit: {{ .Values.worker.miseCache.sizeLimit }}
  {{- end }}
{{- if .Values.egressProxy.enabled }}
- name: egress-ca
  secret:
    secretName: {{ include "holtkeeper.egressCaSecret" . }}
    items:
      - { key: tls.crt, path: tls.crt }
{{- end }}
{{- end -}}

{{/*
The settings of one worker pool: `worker` with the pool's fields on top. Pass the root context as
`ctx` and the pool (or an empty dict for the single default Deployment) as `pool`.
*/}}
{{- define "holtkeeper.workerPool" -}}
{{- $pool := omit .pool "name" "spread" -}}
{{- toYaml (mergeOverwrite (deepCopy (omit .ctx.Values.worker "pools")) $pool) -}}
{{- end -}}

{{- define "holtkeeper.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
