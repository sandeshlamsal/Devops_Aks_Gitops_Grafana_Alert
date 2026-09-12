// Tiny structured logger — one JSON object per line on stdout, no dependency.
// The trace_id/span_id fields are what let Grafana jump log <-> trace: Loki's
// datasource config (observability/grafana-datasources.yaml) has a derived field that
// turns a logged trace_id into a "View Trace" link, and Tempo's config has the reverse
// link back into a Loki query for the same trace_id. Falls back to no ids when tracing
// is disabled (OTEL_EXPORTER_OTLP_ENDPOINT unset, e.g. plain `npm test`) — require()'ing
// @opentelemetry/api is safe either way, it just returns an empty/invalid span context.
const { trace } = require("@opentelemetry/api");

function ids() {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx || !ctx.traceId) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

function line(level, msg, meta) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    msg,
    service: "user-management-app-api",
    ...ids(),
    ...meta,
  };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

module.exports = {
  info: (msg, meta) => line("info", msg, meta),
  error: (msg, meta) => line("error", msg, meta),
};
