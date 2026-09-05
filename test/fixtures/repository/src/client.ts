export async function createOrder() {
  const response = await fetch("https://api.example.test/orders", { method: "POST" });
  return response.json();
}

export async function removeLegacyOrder() {
  return fetch("https://api.example.test/legacy-orders", { method: "DELETE" });
}

export function loadDynamic(path: string) {
  return fetch(process.env.API_BASE + path);
}

export const declared = process.env.DECLARED_TOKEN;
export const missing = import.meta.env.MISSING_TOKEN;
