// OpenTelemetry bootstrap — TRACES only (metrics stay on prom-client/Prometheus,
// logs stay on plain stdout shipped by Grafana Alloy; see infrastructure/observability/
// and the root README's Observability section for why it's split that way).
//
// Loaded via `node --require ./src/tracing.js src/server.js` (see Dockerfile / package.json
// "start" script) so every http/express/pg call is instrumented before the app's own
// modules are required — the standard OTel Node pattern. migrate.js/seed.js/tests never
// load this file, so they carry no tracing overhead.
//
// OTEL_EXPORTER_OTLP_ENDPOINT defaults to the in-cluster otel-collector Service. If
// nothing is listening (e.g. plain `npm start` outside docker-compose/k8s), the OTLP
// exporter just logs export failures in the background — it never crashes the app.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector.monitoring.svc:4318";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "user-management-app-api",
    [ATTR_SERVICE_NAMESPACE]: process.env.APP_ENV || "unknown",
    [ATTR_SERVICE_VERSION]: process.env.IMAGE_TAG || "unknown",
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // the fs instrumentation is extremely noisy (every migration/module read) and
      // adds little value here — everything else (http, express, pg, dns, net) stays on.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => sdk.shutdown().finally(() => process.exit(0)));
}
