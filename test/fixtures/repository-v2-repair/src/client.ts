import { USERS_URL } from "./shared";

export function createOrder() {
  return fetch("https://api.example.test/v1/orders", { method: "POST" });
}

export function listUsers() {
  return axios.get(USERS_URL, { headers: { "X-Client": "fixture" } });
}

export const legacyToken = process.env.LEGACY_TOKEN;
