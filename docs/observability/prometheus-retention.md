# Prometheus Retention and Remote-Write Strategy

## Current configuration

Prometheus runs as a single container via `docker-compose.yml` (`prometheus` service):

```yaml
command:
  - "--config.file=/etc/prometheus/prometheus.yml"
  - "--storage.tsdb.retention.time=35d"
volumes:
  - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  - prometheus-data:/prometheus
```

- **Retention: 35 days**, set via `--storage.tsdb.retention.time=35d` (raised from the
  previous `7d` default to cover the 30-day SLO windows below with slack — see
  "Alignment with SLO windows").
- Storage is local-only TSDB on the named Docker volume `prometheus-data` — there is no
  remote-write target configured in [`docker/prometheus/prometheus.yml`](../../docker/prometheus/prometheus.yml).
- Scrape/evaluation interval is 5s (`docker/prometheus/prometheus.yml`), so retention
  covers a meaningful amount of raw-resolution data, not just a few samples.

## Data-loss implication

`prometheus-data` is a named Docker volume. Running `docker compose down -v` removes
named volumes along with the containers, which **deletes all metrics history**,
including anything within the 7-day retention window. A plain `docker compose down`
(no `-v`) or `docker compose restart prometheus` does not touch the volume and is safe.

This means:
- Any SLO/error-budget calculation that needs history older than 7 days, or that
  spans a `down -v`, has no data to work from.
- There is currently no backup of `prometheus-data` — see the note in
  [dashboard-guide.md](./dashboard-guide.md) about Grafana provisioning being
  code-defined (dashboards survive volume loss); Prometheus's raw metrics do not have
  an equivalent code-defined backing store.

## Remote-write / long-term storage options considered

| Option | Trade-off |
|---|---|
| Increase local `--storage.tsdb.retention.time` (e.g. to 30d+) | Simplest change, no new infra, but still lost entirely on `down -v`; disk usage on the compose host grows with retention × cardinality. |
| Remote-write to a managed backend (Grafana Cloud, Thanos, Mimir, VictoriaMetrics) | Survives volume loss, enables retention far beyond 7d, but adds an external dependency, network egress, and (for hosted options) cost. |
| Periodic snapshot/backup of the `prometheus-data` volume | Cheap to add (`docker run --rm -v prometheus-data:/data ... tar`), keeps data local, but requires a backup schedule and restore process that doesn't exist today. |

## Chosen strategy (interim)

**Interim accepted approach:** raise local retention to cover the SLO measurement
windows and rely on volume durability for now; defer remote-write to a follow-up once
there's an operational need to retain data beyond what local disk can hold or to
survive host loss.

Concretely:
- Retention is set to **`35d`** so the 30-day SLO windows defined in [slo.md](./slo.md)
  have a full window of history plus slack, even across a mid-window Prometheus restart.
- `docker compose down -v` remains destructive by design (it's the documented way to
  reset local dev state) — operators must avoid it on any host being used to track
  real error-budget burn, and this doc is the reference for why.
- Remote-write is **not yet configured**. This is an accepted gap for the current
  single-host deployment; revisit if CareGuard moves to a multi-host or production
  deployment where host loss must not mean metrics loss.

## Alignment with SLO windows

All SLOs in [slo.md](./slo.md) use a 30-day rolling window. A 35-day local retention
gives each SLO a full window of history at all times, including right after a
Prometheus container restart (which does not clear the volume, only `down -v` does).

## Follow-up

If/when remote-write is added, this doc should be updated with the chosen backend,
the `remote_write` block added to `docker/prometheus/prometheus.yml`, and the retention
value reconsidered (local retention can usually shrink once a long-term store exists).
