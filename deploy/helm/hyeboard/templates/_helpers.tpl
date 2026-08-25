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

{{- define "hyeboard.redisImage" -}}
{{- if .tag -}}
{{- printf "%s:%s" .repository .tag -}}
{{- else -}}
{{- .repository -}}
{{- end -}}
{{- end -}}

{{- define "hyeboard.commonLabels" -}}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "hyeboard.validateConfig" -}}
{{- $prohibited := dict "HYEB_ADMIN_DB_PATH" true "HYEB_SESSION_SECRET" true "HYEB_ADMIN_SESSION_SECRET" true "HYEB_ADMIN_PASSWORD_HASH" true "HYEB_ADMIN_GITHUB_CLIENT_SECRET" true "HYEB_ADMIN_DISCORD_CLIENT_SECRET" true "DATABASE_URL" true "HYEB_POSTGRES_URL" true "REDIS_URL" true "HYEB_REDIS_URL" true "AUTOMATION_KEY_CURRENT_ID" true "AUTOMATION_KEY_CURRENT_B64" true "AUTOMATION_KEY_PREVIOUS_ID" true "AUTOMATION_KEY_PREVIOUS_B64" true "BROWSERLESS_ENDPOINT" true "BROWSERLESS_TOKEN" true -}}
{{- range $key, $_ := .Values.config.runtime -}}
{{- if hasKey $prohibited $key -}}
{{- fail (printf "config.runtime contains prohibited key %s" $key) -}}
{{- end -}}
{{- end -}}
{{- range $key, $_ := .Values.config.extraData -}}
{{- if hasKey $prohibited $key -}}
{{- fail (printf "config.extraData contains prohibited key %s" $key) -}}
{{- end -}}
{{- if hasKey $.Values.config.runtime $key -}}
{{- fail (printf "config.extraData duplicates config.runtime key %s" $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "hyeboard.validateApiExtraEnv" -}}
{{- $managed := dict "HYEB_ADMIN_DB_PATH" true "HYEB_SESSION_SECRET" true "HYEB_ADMIN_SESSION_SECRET" true "HYEB_ADMIN_PASSWORD_HASH" true "HYEB_ADMIN_PUBLIC_ORIGIN" true "HYEB_ADMIN_GITHUB_CLIENT_ID" true "HYEB_ADMIN_GITHUB_CLIENT_SECRET" true "HYEB_ADMIN_GITHUB_IDS" true "HYEB_ADMIN_DISCORD_CLIENT_ID" true "HYEB_ADMIN_DISCORD_CLIENT_SECRET" true "HYEB_ADMIN_DISCORD_IDS" true "DATABASE_URL" true "HYEB_POSTGRES_URL" true "REDIS_URL" true "HYEB_REDIS_URL" true "AUTOMATION_KEY_CURRENT_ID" true "AUTOMATION_KEY_CURRENT_B64" true "AUTOMATION_KEY_PREVIOUS_ID" true "AUTOMATION_KEY_PREVIOUS_B64" true "BROWSERLESS_ENDPOINT" true "BROWSERLESS_TOKEN" true "HYEB_HA_MODE" true "HYEB_HA_NODE_ID" true "AUTOMATION_CONSUMER_NAME" true "AUTOMATION_CONTROL_CONSUMER_NAME" true "TOKEN" true -}}
{{- range $key, $_ := .Values.config.runtime -}}
{{- $_ := set $managed $key true -}}
{{- end -}}
{{- range $key, $_ := .Values.config.extraData -}}
{{- $_ := set $managed $key true -}}
{{- end -}}
{{- $seen := dict -}}
{{- range .Values.api.extraEnv -}}
{{- $name := required "api.extraEnv item name is required" .name -}}
{{- if hasKey $seen $name -}}
{{- fail (printf "api.extraEnv contains duplicate name %s" $name) -}}
{{- end -}}
{{- if hasKey $managed $name -}}
{{- fail (printf "api.extraEnv contains chart-managed name %s" $name) -}}
{{- end -}}
{{- $_ := set $seen $name true -}}
{{- end -}}
{{- end -}}
