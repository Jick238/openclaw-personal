// Process-local ingress timing follows an update across polling/webhook admission
// without creating persistent state or changing Telegram's update payload.
const ingressReceivedAt = new WeakMap<object, number>();

export function markTelegramIngressReceived(update: unknown, receivedAt = Date.now()): void {
  if (update && typeof update === "object") {
    ingressReceivedAt.set(update, receivedAt);
  }
}

export function getTelegramIngressReceivedAt(update: unknown): number | undefined {
  return update && typeof update === "object" ? ingressReceivedAt.get(update) : undefined;
}
