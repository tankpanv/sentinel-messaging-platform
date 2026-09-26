import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) process.env.OTEL_TRACES_EXPORTER = 'none';
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'sentinel-service',
    traceExporter: endpoint ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }) : undefined,
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  process.once('SIGTERM', () => { void sdk.shutdown().finally(() => process.exit(0)); });
}
