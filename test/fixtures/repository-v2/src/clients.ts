export async function createOrder() {
  return fetch("https://api.example.test/orders", { method: "POST", headers: { "Authorization": "Bearer token" }, body: JSON.stringify({ sku: "A-1" }) });
}
export async function listUsers() { return axios.get("https://api.example.test/users"); }
