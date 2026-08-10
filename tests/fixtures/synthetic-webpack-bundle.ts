export const SYNTHETIC_WEBPACK_BUNDLE = `
(self.webpackChunk_snapchat_web = self.webpackChunk_snapchat_web || []).push([
  [101],
  {
    "alpha": function(module) { module.exports = "unrelated"; },
    "crypto": function(module) {
      const names = ["ContentEnvelope", "EnvelopeEncryption", "FideliusEncryption"];
      module.exports = names;
    },
    "media": function(module) { module.exports = "MediaDeliveryService"; }
  }
]);
`;
