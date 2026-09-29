// Minimal stand-in for the `cloudflare:email` module so alert-email code can be unit
// tested under Node. Real EmailMessage validates from/to/raw against the platform's
// send_email binding rules; this stub just records the constructor arguments.
export class EmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
