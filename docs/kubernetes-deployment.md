# Triển khai Hyeboard trên Kubernetes

Dùng Helm chart từ OCI registry:

`oci://ghcr.io/teppyboy/charts/hyeboard`

## 1. Cần chuẩn bị

Cluster cần có:

- PostgreSQL và connection URL.
- NGINX Ingress Controller với IngressClass `nginx`.
- DNS trỏ hostname production vào Ingress.
- Certificate và private key cho hostname đó.
- Redis Operator OT-CONTAINER-KIT cùng CRD `RedisReplication`.
- StorageClass có thể tạo Redis PVC.
- `kubectl` và Helm.

Kiểm tra nhanh:

```bash
kubectl config current-context
kubectl get nodes
kubectl get ingressclass nginx
kubectl get crd redisreplications.redis.redis.opstreelabs.in
kubectl get storageclass
helm version
```

Redis Operator phải được cài sẵn. Helm chart chỉ tạo `RedisReplication`, không
cài operator hoặc CRD.

## 2. Tạo file values.yml

Tạo `values.yml` trên máy triển khai. File này chứa cả cấu hình và credential,
nên chỉ lưu cục bộ:

```yaml
images:
  api:
    repository: ghcr.io/teppyboy/hyeboard-api
    tag: sha-<40-character-commit-sha>
  automationWorker:
    repository: ghcr.io/teppyboy/hyeboard-automation-worker
    tag: sha-<40-character-commit-sha>

secrets:
  create: true
  runtime:
    HYEB_SESSION_SECRET: "<random-secret-at-least-32-characters>"
    HYEB_POSTGRES_URL: "<managed-postgresql-url>"
    HYEB_REDIS_URL: "redis://:<redis-password>@hyeboard-redis-master:6379/0"
    AUTOMATION_KEY_CURRENT_ID: "<automation-key-id>"
    AUTOMATION_KEY_CURRENT_B64: "<base64-encoded-32-byte-key>"
    BROWSERLESS_ENDPOINT: "ws://hyeboard-browserless:3000/chromium"
    BROWSERLESS_TOKEN: "<browserless-token>"
  redisAuth:
    existingSecret: hyeboard-redis-auth
    key: password
    password: "<redis-password>"

config:
  runtime:
    HYEB_ALLOWED_ORIGINS: https://hyeboard.example.com

api:
  replicaCount: 3

automationWorker:
  replicaCount: 3

browserless:
  enabled: true
  replicaCount: 3

redis:
  operator:
    enabled: true

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: hyeboard.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: hyeboard-tls
      hosts:
        - hyeboard.example.com
```

Thay tất cả placeholder. `<redis-password>` phải giống nhau trong
`HYEB_REDIS_URL` và `redisAuth.password`. Có thể tạo password bằng:

```bash
openssl rand -hex 32
```

Tạo TLS Secret trước khi cài chart:

```bash
kubectl create namespace hyeboard
kubectl -n hyeboard create secret tls hyeboard-tls --cert=/path/to/fullchain.pem --key=/path/to/privkey.pem
```

Giữ file riêng tư:

```bash
chmod 600 values.yml
```

Không commit `values.yml` vào repository.

## 3. Cài chart từ OCI registry

Nếu chart GHCR là private, đăng nhập một lần:

```bash
echo '<github-token>' | helm registry login ghcr.io --username <github-username> --password-stdin
```

Sau đó cài hoặc nâng cấp bằng một lệnh. `0.2.0` là version chart hiện tại:

```bash
helm upgrade --install hyeboard oci://ghcr.io/teppyboy/charts/hyeboard --version 0.2.0 --namespace hyeboard --create-namespace --values ./values.yml --wait --atomic --timeout 5m
```

Chart sẽ tạo runtime Secret, Redis auth Secret, API, worker, Browserless,
RedisReplication, Ingress, HPA và PDB.

## 4. Kiểm tra

```bash
kubectl -n hyeboard get pods,svc,ingress,redisreplication
kubectl -n hyeboard rollout status deployment/hyeboard-api --timeout=5m
kubectl -n hyeboard rollout status deployment/hyeboard-automation-worker --timeout=5m
kubectl -n hyeboard rollout status deployment/hyeboard-browserless --timeout=5m
kubectl -n hyeboard get redisreplication hyeboard-redis
curl -fsS https://hyeboard.example.com/api/live
curl -fsS https://hyeboard.example.com/api/ready
```

`/api/ready` phải thành công trước khi coi triển khai là hoàn tất.

Nếu Pod không Ready:

```bash
kubectl -n hyeboard get events --sort-by=.lastTimestamp
kubectl -n hyeboard logs deployment/hyeboard-api --tail=100
kubectl -n hyeboard logs deployment/hyeboard-automation-worker --tail=100
kubectl -n hyeboard describe redisreplication hyeboard-redis
```

`HYEB_AUTOMATION_EXECUTOR_READY` mặc định vẫn là `false`. Chỉ bật sau khi
executor đã được kiểm chứng với provider thật.

## 5. Rollback

```bash
helm history hyeboard --namespace hyeboard
helm rollback hyeboard <revision> --namespace hyeboard --wait --timeout 5m
```

## Checklist

- [ ] Đúng Kubernetes context.
- [ ] PostgreSQL, Ingress, DNS, TLS và Redis Operator đã sẵn sàng.
- [ ] Hai image dùng tag SHA hoặc digest tồn tại trên GHCR.
- [ ] `values.yml` có đủ cấu hình và credential.
- [ ] `values.yml` không được commit hoặc gửi vào ticket.
- [ ] API, worker, Browserless, RedisReplication và `/api/ready` đã kiểm tra.
