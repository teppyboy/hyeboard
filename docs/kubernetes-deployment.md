# Triển khai Hyeboard trên Kubernetes

Dùng Helm chart từ OCI registry:

`oci://ghcr.io/teppyboy/charts/hyeboard`

## 1. Cần chuẩn bị

Cluster cần có:

- PostgreSQL và connection URL.
- NGINX Ingress Controller với IngressClass `nginx`.
- DNS trỏ hostname production vào Ingress.
- Certificate và private key cho hostname đó.
- CRD `RedisReplication` và Redis Operator OT-CONTAINER-KIT chạy trong namespace
  riêng `ot-operators` với quyền cluster-scoped và watch toàn bộ namespace.
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

Helm chart ứng dụng chỉ tạo `RedisReplication`, không sở hữu operator hoặc CRD.
Operator được cài riêng trong `ot-operators`. Với `rbac.scope=cluster` và không
đặt `redisOperator.watchNamespace`, operator sẽ watch toàn bộ namespace để các
Redis resource của những service khác trong tương lai cũng được reconcile:

## 2. Cài Redis Operator

```bash
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts
helm repo update

helm upgrade --install redis-operator ot-helm/redis-operator \
  --namespace ot-operators \
  --create-namespace \
  --version 0.26.1 \
  --set rbac.scope=cluster \
  --set featureGates.GenerateConfigInInitContainer=true

kubectl get crd redisreplications.redis.redis.opstreelabs.in
kubectl -n ot-operators rollout status deployment/redis-operator --timeout=180s
```

CRD là cluster-scoped và phải được giữ lại khi gỡ Helm release ứng dụng. Các
NetworkPolicy của namespace chứa Redis phải cho phép operator trong
`ot-operators` truy cập workload tương ứng.

## 3. Tạo file hyeboard-values.yml

Tạo `hyeboard-values.yml` trên máy triển khai. File này chứa cả cấu hình và credential,
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
    HYEB_POSTGRES_URL: "postgresql://<USERNAME>:<PASSWORD>@<HOST>:5432/<DATABASE>"
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
    HYEB_AUTOMATION_EXECUTOR_READY: false

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
kubectl -n hyeboard create secret tls hyeboard-tls --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

Không commit `hyeboard-values.yml` vào repository.

## 4. Cài chart từ OCI registry

Nếu chart GHCR là private, đăng nhập một lần:

```bash
echo '<github-token>' | helm registry login ghcr.io --username <github-username> --password-stdin
```

Sau đó cài hoặc nâng cấp bằng một lệnh:

```bash
helm upgrade --install hyeboard oci://ghcr.io/teppyboy/charts/hyeboard --namespace hyeboard --values ./hyeboard-values.yml --rollback-on-failure
```

Chart sẽ tạo runtime Secret, Redis auth Secret, API, worker, Browserless,
RedisReplication, Ingress, HPA và PDB.

## 5. Kiểm tra

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

## 6. Rollback

```bash
helm history hyeboard --namespace hyeboard
helm rollback hyeboard <revision> --namespace hyeboard --timeout 5m
```

## 7. Gỡ cài đặt

```bash
helm uninstall hyeboard --namespace hyeboard --wait --timeout 5m
kubectl delete namespace hyeboard --wait --timeout 5m
```

## Checklist

- [ ] Đúng Kubernetes context.
- [ ] PostgreSQL, Ingress, DNS, TLS và Redis Operator trong `ot-operators` đã sẵn sàng.
- [ ] Hai image dùng tag SHA hoặc digest tồn tại trên GHCR.
- [ ] `hyeboard-values.yml` có đủ cấu hình và credential.
- [ ] `hyeboard-values.yml` không được commit hoặc gửi vào ticket.
- [ ] API, worker, Browserless, RedisReplication và `/api/ready` đã kiểm tra.
