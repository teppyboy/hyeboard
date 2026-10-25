# Bun for published containers

The API and automation-worker container images use Bun as their production runtime across Compose, Kubernetes, and Helm, while the standalone self-hosted Node.js entry point remains supported. This keeps the operational runtime aligned with the project's Bun-first deployment target without removing Node.js compatibility or the separate Cloudflare runtime.
