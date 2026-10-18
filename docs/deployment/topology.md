# Deployment Topology

## Docker Compose (Local Dev)

The local development stack runs five services on a shared bridge network (`careguard`).
Persistent data is kept in named Docker volumes.

```mermaid
graph TB
  subgraph external["External Dependencies"]
    H["Horizon RPC<br/>(soroban-testnet.stellar.org)"]
    OZ["OZ Facilitator<br/>(channels.openzeppelin.com)"]
    LLM["LLM Provider<br/>(api.groq.com)"]
  end

  subgraph compose["Docker Compose — careguard network"]
    subgraph services["Services"]
      S["server<br/>port 3004<br/>volume: ./data"]
      D["dashboard<br/>port 3000<br/>Next.js"]
      R["redis:7-alpine<br/>port 6379<br/>volume: redis-data"]
      P["prometheus<br/>port 9090<br/>volume: prometheus-data"]
      G["grafana<br/>port 3030<br/>volume: grafana-data"]
    end

    S -->|health check| D
    S -->|rate limit / cache| R
    S -->|metrics| P
    P -->|data source| G
    S -->|HTTP| H
    S -->|HTTP| OZ
    S -->|HTTP| LLM
  end

  style external fill:#f5f5f5,stroke:#999,stroke-dasharray:5 5
  style compose fill:#e8f4f8,stroke:#333
```

### Port Map

| Service | Internal Port | Host Port |
|---------|---------------|-----------|
| server  | 3004          | 3004      |
| dashboard | 3000        | 3000      |
| redis   | 6379          | 6379      |
| prometheus | 9090      | 9090      |
| grafana | 3000          | 3030      |

### Persistent Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `./data` | `/app/data` | Server data (spending history, audit logs) |
| `redis-data` | `/data` | Redis append-only persistence |
| `prometheus-data` | `/prometheus` | Time-series metrics (35d retention) |
| `grafana-data` | `/var/lib/grafana` | Dashboard configuration |

---

## Render (Production)

The production deployment runs a single `web` service on Render's Node.js runtime.
Monitoring and caching services are not self-hosted in production; the server
relies on managed Redis (Render Redis) and external monitoring providers.

```mermaid
graph TB
  subgraph external["External Dependencies"]
    H["Horizon RPC<br/>(soroban-testnet.stellar.org)"]
    OZ["OZ Facilitator<br/>(x402/testnet)"]
    LLM["LLM Provider<br/>(api.groq.com / llama-3.3-70b)"]
    RENDER_REDIS["Render Redis<br/>(managed)"]
  end

  subgraph render["Render — careguard-api"]
    S["server (Node.js 22)<br/>port 3004<br/>start: node dist/server.js"]
  end

  subgraph clients["Clients"]
    W["Dashboard (Next.js)<br/>hosted separately"]
  end

  W -->|HTTP :3004| S
  S -->|cache / rate-limit| RENDER_REDIS
  S -->|HTTP| H
  S -->|HTTP| OZ
  S -->|HTTP| LLM

  style external fill:#f5f5f5,stroke:#999,stroke-dasharray:5 5
  style render fill:#fef3e2,stroke:#333
```

### Render Service Properties

| Property | Value |
|----------|-------|
| Type | `web` |
| Runtime | Node.js 22 |
| Plan | Free |
| Build | `npm ci && npm run build` |
| Start | `node dist/server.js` |
| Health | `/health` |

### Resource Comparison

| Resource | Docker Compose | Render |
|----------|----------------|--------|
| Server | Container on `careguard` network | Single `web` service |
| Dashboard | Container on `careguard` network | Hosted separately |
| Redis | `redis:7-alpine` container | Managed Render Redis |
| Prometheus | `prom/prometheus` container | External monitoring |
| Grafana | `grafana/grafana` container | External monitoring |
| Persistent storage | Named volumes | Render disk (if configured) |

---

## Service Dependencies

- **server** → redis (caching, rate limiting)
- **server** → prometheus (metrics export)
- **dashboard** → server (REST API)
- **server** → Horizon RPC (Stellar on-chain queries)
- **server** → OZ Facilitator (x402 payment channels)
- **server** → LLM Provider (AI-powered interactions)
