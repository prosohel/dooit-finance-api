const mongoose = require("mongoose");
const { payloadHashOf, signatureOf } = require("../utils/exchangeCrypto");

const { Schema } = mongoose;

/**
 * ExchangeEvent — the hub copy of every signed event that moves between AFC OS,
 * the Client Portal (ui), the GRC Platform (ewra_ui) and the BFIU workspace
 * (plans/integration/02 decision A1: the platform API is the exchange hub).
 *
 * `seq` is a monotonic counter so a consumer can poll `?after=<seq>` without
 * missing or repeating events. Receipts (delivered / read / acknowledged) are
 * recorded on the event and echoed back as `receipt.*` events addressed to
 * the producer, so the producer's poll sees them.
 */
const EndpointSchema = new Schema(
  {
    app: { type: String, enum: ["afcos", "portal", "grc", "bfiu", "platform"], required: true },
    body: { type: String, default: null },
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    roId: { type: String, default: null },
  },
  { _id: false }
);

const ExchangeEventSchema = new Schema(
  {
    seq: { type: Number, required: true, unique: true, index: true },
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true, index: true },
    version: { type: Number, default: 1 },
    occurredAt: { type: Date, default: Date.now },
    from: { type: EndpointSchema, required: true },
    to: { type: EndpointSchema, required: true },
    subject: { kind: { type: String, required: true }, id: { type: String, default: null }, uid: { type: String, default: null, index: true } },
    payload: { type: Schema.Types.Mixed, required: true },
    payloadHash: { type: String, required: true },
    signature: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["queued", "delivered", "read", "acknowledged", "failed"], default: "queued", index: true },
    receipts: {
      deliveredAt: { type: Date, default: null },
      readAt: { type: Date, default: null },
      acknowledgedAt: { type: Date, default: null },
      note: { type: String, default: null },
    },
    /** Who handed the event to the hub: "afcos" (service signature) or a platform user id (tenant). */
    receivedVia: { type: String, default: null },
    actor: { user: { type: Schema.Types.ObjectId, default: null }, name: { type: String, default: null }, role: { type: String, default: null }, body: { type: String, default: null } },
  },
  { timestamps: true, collection: "exchange_events" }
);

ExchangeEventSchema.index({ "to.app": 1, "to.client": 1, seq: 1 });
ExchangeEventSchema.index({ "from.app": 1, seq: 1 });

/** Hub-issued events (from tenants) are hashed and signed here; AFC OS-issued ones arrive signed and are verified before save. */
ExchangeEventSchema.pre("validate", function sign(next) {
  if (this.isNew && !this.payloadHash) {
    this.payloadHash = payloadHashOf(this.payload);
    this.signature = signatureOf(this.payloadHash);
  }
  next();
});

const CounterSchema = new Schema({ _id: String, n: { type: Number, default: 0 } }, { collection: "exchange_counters" });
const ExchangeCounter = mongoose.models.ExchangeCounter || mongoose.model("ExchangeCounter", CounterSchema);

ExchangeEventSchema.statics.nextSeq = async function nextSeq() {
  const row = await ExchangeCounter.findOneAndUpdate({ _id: "seq" }, { $inc: { n: 1 } }, { upsert: true, new: true });
  return row.n;
};
ExchangeEventSchema.statics.nextEventId = async function nextEventId() {
  const year = new Date().getFullYear();
  const row = await ExchangeCounter.findOneAndUpdate({ _id: `evt:${year}` }, { $inc: { n: 1 } }, { upsert: true, new: true });
  return `EVT-HUB-${year}-${String(row.n).padStart(6, "0")}`;
};

module.exports = mongoose.model("ExchangeEvent", ExchangeEventSchema);
