{{- define "hyeboard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.fullname" -}}
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

{{- define "hyeboard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.labels" -}}
helm.sh/chart: {{ include "hyeboard.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "hyeboard.apiName" -}}
{{- printf "%s-api" (include "hyeboard.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.automationWorkerName" -}}
{{- printf "%s-automation-worker" (include "hyeboard.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.browserlessName" -}}
{{- printf "%s-browserless" (include "hyeboard.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.redisName" -}}
{{- .Values.redis.operator.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hyeboard.apiSelectorLabels" -}}
app.kubernetes.io/name: {{ include "hyeboard.apiName" . }}
app.kubernetes.io/component: api
{{- end -}}

{{- define "hyeboard.automationWorkerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "hyeboard.automationWorkerName" . }}
app.kubernetes.io/component: automation-worker
{{- end -}}

{{- define "hyeboard.secretName" -}}
{{- required "secrets.existingSecret is required" .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "hyeboard.apiServiceAccountName" -}}
{{- if .Values.serviceAccounts.api.name -}}
{{- .Values.serviceAccounts.api.name -}}
{{- else -}}
{{- include "hyeboard.apiName" . -}}
{{- end -}}
{{- end -}}

{{- define "hyeboard.automationWorkerServiceAccountName" -}}
{{- if .Values.serviceAccounts.automationWorker.name -}}
{{- .Values.serviceAccounts.automationWorker.name -}}
{{- else -}}
{{- include "hyeboard.automationWorkerName" . -}}
{{- end -}}
{{- end -}}

{{- define "hyeboard.image" -}}
{{- $image := .image -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $image.repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $image.repository $image.tag -}}
{{- end -}}
{{- end -}}

{{- define "hyeboard.commonLabels" -}}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}
