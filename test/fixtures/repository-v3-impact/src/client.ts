export function createOrder() {
  return fetch("https://api.example.test/orders", { method: "POST", body: JSON.stringify({ customer_name: "Ada", amount: "unknown" }) });
}

export function loadLegacy() {
  return fetch("https://api.example.test/legacy");
}
