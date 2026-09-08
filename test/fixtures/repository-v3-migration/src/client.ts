export function createOrder() {
  return fetch("https://api.example.test/orders", { method: "POST", body: JSON.stringify({ amount: "42" }) });
}
